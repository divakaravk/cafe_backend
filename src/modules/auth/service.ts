import { randomBytes, createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PoolConnection } from 'mysql2/promise';
import { newId } from '../../lib/ids.js';
import { verifyPassword, hashPassword } from '../../lib/argon.js';
import { withTransaction } from '../../lib/tx.js';
import { Errors, AppError } from '../../plugins/errors.js';
import { invalidateAuthCache } from '../../plugins/auth.js';
import { config } from '../../config.js';

export interface UserRow {
  id: string;
  company_id: string | null;
  employee_code: string;
  user_name: string;
  username: string;
  password_hash: string;
  user_role: string;
  mob_number: string | null;
  user_email: string | null;
  user_active: boolean;
  last_login: Date | null;
  created_at: Date;
  avatar_url: string | null;
  is_login: boolean;
  token_version: number;
  failed_logins: number;
  locked_until: Date | null;
}

/** The row shape the Dart `UserProfile.fromJson` expects — i.e. everything
 * PostgREST used to return except `password`/`password_hash`, which the API
 * must never put on the wire (Supabase mode's one real security gap this
 * fixes — see docs/backend-migration/PLAN.md §1.3's optional-fixes list). */
export function toProfileJson(row: UserRow) {
  return {
    id: row.id,
    company_id: row.company_id,
    employee_code: row.employee_code,
    user_name: row.user_name,
    username: row.username,
    user_role: row.user_role,
    mob_number: row.mob_number,
    user_email: row.user_email,
    user_active: row.user_active,
    last_login: row.last_login ? new Date(row.last_login).toISOString() : null,
    created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
    avatar_url: row.avatar_url,
    is_login: row.is_login,
  };
}

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

function newRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

async function createSession(
  conn: PoolConnection,
  params: { userId: string; ip?: string; deviceLabel?: string },
): Promise<{ sessionId: string; rawToken: string }> {
  const sessionId = newId();
  const rawToken = newRefreshToken();
  const expiresAt = new Date(Date.now() + config.REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000);
  await conn.execute(
    `INSERT INTO auth_session (id, user_id, refresh_token_hash, device_label, ip, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [sessionId, params.userId, hashToken(rawToken), params.deviceLabel ?? null, params.ip ?? null, expiresAt],
  );
  return { sessionId, rawToken };
}

function signAccess(
  app: FastifyInstance,
  row: Pick<UserRow, 'id' | 'company_id' | 'user_role' | 'token_version'>,
  sessionId: string,
) {
  return app.jwt.sign({ sub: row.id, cid: row.company_id, role: row.user_role, sid: sessionId, tv: row.token_version });
}

function expiresInSeconds(): number {
  const m = /^(\d+)(s|m|h|d)$/.exec(config.ACCESS_TTL);
  if (!m) return 1800;
  const n = Number(m[1]);
  const mult = { s: 1, m: 60, h: 3600, d: 86400 }[m[2] as 's' | 'm' | 'h' | 'd'];
  return n * mult;
}

/** Exact port of `SupabaseService.signInWithUserMaster` (supabase_service.dart):
 * same 5 steps, same order, same thrown message text, so the login screen's
 * substring-matching UX (`login_screen.dart`) behaves identically regardless
 * of backend. The one behaviour change is deliberate and documented in
 * docs/backend-migration/PLAN.md §3.4: an email shared by 2+ accounts (a real
 * row in the live data) now fails closed with `AMBIGUOUS_EMAIL` instead of
 * PostgREST silently picking one of them. */
export async function login(
  app: FastifyInstance,
  params: { input: string; password: string; forceLogin: boolean; ip?: string; deviceLabel?: string },
) {
  const trimmed = params.input.trim();

  return withTransaction(app.db, async (conn) => {
    let user: UserRow | undefined;

    const [byUsername] = await conn.query('SELECT * FROM user_profiles WHERE username = ? LIMIT 1 FOR UPDATE', [
      trimmed,
    ]);
    user = (byUsername as UserRow[])[0];

    if (!user) {
      const [byEmail] = await conn.query(
        'SELECT * FROM user_profiles WHERE user_email = ? FOR UPDATE',
        [trimmed],
      );
      const matches = byEmail as UserRow[];
      if (matches.length > 1) {
        throw new AppError(
          409,
          'AMBIGUOUS_EMAIL',
          'Multiple accounts use this email address. Please sign in with your username instead.',
        );
      }
      user = matches[0];
    }

    if (!user) {
      throw new AppError(404, 'NO_ACCOUNT', `No account found for "${trimmed}". Check your username or email.`);
    }
    if (!user.user_active) {
      throw new AppError(403, 'ACCOUNT_INACTIVE', 'This account is deactivated. Contact your administrator.');
    }
    const passwordOk = await verifyPassword(params.password, user.password_hash);
    if (!passwordOk) {
      throw new AppError(401, 'BAD_PASSWORD', 'Incorrect password. Please try again.');
    }
    if (user.is_login && !params.forceLogin) {
      throw new AppError(409, 'ALREADY_LOGGED_IN', 'ALREADY_LOGGED_IN');
    }

    const now = new Date();
    await conn.execute('UPDATE user_profiles SET is_login = 1, last_login = ? WHERE id = ?', [now, user.id]);
    user.is_login = true;
    user.last_login = now;

    const { sessionId, rawToken } = await createSession(conn, {
      userId: user.id,
      ip: params.ip,
      deviceLabel: params.deviceLabel,
    });
    invalidateAuthCache(user.id);

    return {
      access_token: signAccess(app, user, sessionId),
      refresh_token: rawToken,
      expires_in: expiresInSeconds(),
      profile: toProfileJson(user),
    };
  });
}

type RefreshOutcome =
  | { ok: true; access_token: string; refresh_token: string; expires_in: number }
  | { ok: false; message: string; invalidateUserId?: string };

/** IMPORTANT: this never `throw`s from inside the transaction callback.
 * `withTransaction` rolls back on any thrown error — but the reuse-detected
 * branch's whole point is a DB write (revoke every session for the user) that
 * must survive even though the request itself ends in a 401. Returning a
 * result and throwing *after* the transaction commits was the fix for a real
 * bug caught by the smoke test (scripts/smoke.mjs): the revoke-the-family
 * write was silently rolled back before this refactor. */
async function refreshTx(app: FastifyInstance, rawToken: string): Promise<RefreshOutcome> {
  return withTransaction(app.db, async (conn) => {
    const [rows] = await conn.query(
      `SELECT s.id AS session_id, s.user_id, s.revoked_at, s.expires_at, u.*
         FROM auth_session s JOIN user_profiles u ON u.id = s.user_id
        WHERE s.refresh_token_hash = ? FOR UPDATE`,
      [hashToken(rawToken)],
    );
    const row = (rows as (UserRow & { session_id: string; user_id: string; revoked_at: Date | null; expires_at: Date })[])[0];
    if (!row) return { ok: false, message: 'Invalid refresh token.' };

    if (row.revoked_at) {
      // Reuse of an already-rotated/revoked token: treat as a compromise
      // signal and kill every session for this user, not just this one.
      await conn.execute(
        "UPDATE auth_session SET revoked_at = NOW(3), revoked_reason = 'reuse_detected' WHERE user_id = ? AND revoked_at IS NULL",
        [row.user_id],
      );
      return { ok: false, message: 'Session revoked. Please sign in again.', invalidateUserId: row.user_id };
    }
    if (new Date(row.expires_at).getTime() < Date.now()) {
      return { ok: false, message: 'Session expired. Please sign in again.' };
    }
    if (!row.user_active) {
      return { ok: false, message: 'Your account is inactive. Contact your administrator.' };
    }

    // Rotate: revoke this token, issue a new one under a NEW session row (the
    // old row is kept, marked revoked, for the reuse-detection check above).
    await conn.execute(
      "UPDATE auth_session SET revoked_at = NOW(3), revoked_reason = 'replaced' WHERE id = ?",
      [row.session_id],
    );
    const { sessionId, rawToken: newRaw } = await createSession(conn, { userId: row.user_id });

    return {
      ok: true,
      access_token: signAccess(app, row, sessionId),
      refresh_token: newRaw,
      expires_in: expiresInSeconds(),
    };
  });
}

export async function refresh(app: FastifyInstance, rawToken: string) {
  const outcome = await refreshTx(app, rawToken);
  if (!outcome.ok) {
    if (outcome.invalidateUserId) invalidateAuthCache(outcome.invalidateUserId);
    throw Errors.unauthorized(outcome.message);
  }
  const { ok: _ok, ...body } = outcome;
  return body;
}

export async function logout(app: FastifyInstance, rawToken: string | undefined) {
  if (!rawToken) return;
  await app.db.execute(
    "UPDATE auth_session SET revoked_at = NOW(3), revoked_reason = 'logout' WHERE refresh_token_hash = ? AND revoked_at IS NULL",
    [hashToken(rawToken)],
  );
}

export async function getSessionStatus(app: FastifyInstance, userId: string) {
  const [rows] = await app.db.query(
    'SELECT user_active, is_login, last_login FROM user_profiles WHERE id = ?',
    [userId],
  );
  const row = (rows as { user_active: boolean; is_login: boolean; last_login: Date | null }[])[0];
  if (!row) return null;
  return {
    user_active: row.user_active,
    is_login: row.is_login,
    last_login: row.last_login ? new Date(row.last_login).toISOString() : null,
  };
}

export async function setLoginStatus(app: FastifyInstance, userId: string, isLogin: boolean) {
  await app.db.execute('UPDATE user_profiles SET is_login = ? WHERE id = ?', [isLogin, userId]);
}

/** Returns false (never throws) when the current password is wrong — same
 * contract as `SupabaseService.changePassword`. */
export async function changePassword(
  app: FastifyInstance,
  params: { userId: string; currentPassword: string; newPassword: string },
): Promise<boolean> {
  const [rows] = await app.db.query('SELECT password_hash FROM user_profiles WHERE id = ?', [params.userId]);
  const row = (rows as { password_hash: string }[])[0];
  if (!row) return false;
  if (!(await verifyPassword(params.currentPassword, row.password_hash))) return false;

  const newHash = await hashPassword(params.newPassword);
  await app.db.execute(
    'UPDATE user_profiles SET password_hash = ?, token_version = token_version + 1 WHERE id = ?',
    [newHash, params.userId],
  );
  await app.db.execute(
    "UPDATE auth_session SET revoked_at = NOW(3), revoked_reason = 'password_changed' WHERE user_id = ? AND revoked_at IS NULL",
    [params.userId],
  );
  invalidateAuthCache(params.userId);
  return true;
}
