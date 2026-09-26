import type { FastifyInstance } from 'fastify';
import { newId } from '../../lib/ids.js';
import { hashPassword } from '../../lib/argon.js';
import { withTransaction } from '../../lib/tx.js';
import { invalidateAuthCache } from '../../plugins/auth.js';
import { Errors } from '../../plugins/errors.js';
import { toProfileJson, type UserRow } from '../auth/service.js';
import type { z } from 'zod';
import type { UserInput, PermissionInput } from './schemas.js';

export async function getUsersForCompany(app: FastifyInstance, companyId: string) {
  const [rows] = await app.db.query('SELECT * FROM user_profiles WHERE company_id = ? ORDER BY user_name', [
    companyId,
  ]);
  return (rows as UserRow[]).map(toProfileJson);
}

export async function getUserPermissions(app: FastifyInstance, userId: string) {
  const [rows] = await app.db.query('SELECT * FROM user_permission WHERE user_id = ?', [userId]);
  return (rows as Record<string, unknown>[])[0] ?? null;
}

export async function upsertUserWithPermissions(
  app: FastifyInstance,
  params: {
    user: z.infer<typeof UserInput>;
    permissions: z.infer<typeof PermissionInput>;
    isNew: boolean;
    /** null for the platform owner acting company-wide; otherwise the caller's own company. */
    actingCompanyId: string | null;
    actingRole: string;
  },
) {
  const { user, permissions, isNew } = params;
  // Tenant isolation: a company user is always pinned to the caller's own
  // company. Only the owner (company_id == null) may target another one.
  const companyId = params.actingRole === 'owner' ? (user.company_id ?? null) : params.actingCompanyId;

  if (isNew && !user.password) {
    throw Errors.badRequest('Password is required for new users.');
  }

  return withTransaction(app.db, async (conn) => {
    const id = user.id ?? newId();
    const passwordHash = user.password ? await hashPassword(user.password) : undefined;

    if (isNew) {
      if (!passwordHash) throw Errors.badRequest('Password is required for new users.');
      await conn.execute(
        `INSERT INTO user_profiles
           (id, company_id, employee_code, user_name, username, password_hash, user_role,
            mob_number, user_email, user_active, avatar_url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          companyId,
          user.employee_code,
          user.user_name,
          user.username,
          passwordHash,
          user.user_role,
          user.mob_number ?? null,
          user.user_email ?? null,
          user.user_active ?? true,
          user.avatar_url ?? null,
        ],
      );
    } else {
      const sets = [
        'company_id = ?',
        'employee_code = ?',
        'user_name = ?',
        'username = ?',
        'user_role = ?',
        'mob_number = ?',
        'user_email = ?',
        'user_active = ?',
        'avatar_url = ?',
      ];
      const values: unknown[] = [
        companyId,
        user.employee_code,
        user.user_name,
        user.username,
        user.user_role,
        user.mob_number ?? null,
        user.user_email ?? null,
        user.user_active ?? true,
        user.avatar_url ?? null,
      ];
      if (passwordHash) {
        sets.push('password_hash = ?', 'token_version = token_version + 1');
        values.push(passwordHash);
      }
      values.push(id);
      const [result] = await conn.execute(`UPDATE user_profiles SET ${sets.join(', ')} WHERE id = ?`, values as any[]);
      if ((result as { affectedRows: number }).affectedRows === 0) {
        throw Errors.notFound('User');
      }
      if (passwordHash) invalidateAuthCache(id);
    }

    const permCols = Object.keys(permissions) as (keyof typeof permissions)[];
    await conn.execute(
      `INSERT INTO user_permission (id, user_id, ${permCols.join(', ')})
       VALUES (?, ?, ${permCols.map(() => '?').join(', ')})
       ON DUPLICATE KEY UPDATE ${permCols.map((c) => `${c} = VALUES(${c})`).join(', ')}`,
      [newId(), id, ...permCols.map((c) => permissions[c])],
    );

    return { id };
  });
}

/** Deactivates + force-logs-out a user (admin action). Unlike the old direct
 * `SupabaseService.client` call this replaces, it also revokes sessions and
 * bumps `token_version` so the device is actually locked out within ~10s,
 * not just flagged in a column the device never re-checks until its own
 * 20s poll happens to run.
 *
 * [actingCompanyId] scopes the target to the caller's own company (null for
 * the owner, who may act on any company). `requirePerm` lets every admin
 * through regardless of *which* company they admin — this is the check that
 * actually stops a company-2 admin from touching a company-1 user; a real
 * gap the smoke test (scripts/smoke.mjs) caught before this fix existed. */
export async function forceLogoutUser(app: FastifyInstance, userId: string, actingCompanyId: string | null) {
  const scoped = actingCompanyId !== null;
  const [result] = await app.db.execute(
    `UPDATE user_profiles SET user_active = 0, is_login = 0, token_version = token_version + 1
      WHERE id = ? ${scoped ? 'AND company_id = ?' : ''}`,
    scoped ? [userId, actingCompanyId] : [userId],
  );
  if ((result as { affectedRows: number }).affectedRows === 0) {
    throw Errors.notFound('User');
  }
  await app.db.execute(
    "UPDATE auth_session SET revoked_at = NOW(3), revoked_reason = 'force_logout' WHERE user_id = ? AND revoked_at IS NULL",
    [userId],
  );
  invalidateAuthCache(userId);
}

export async function updateOwnProfile(
  app: FastifyInstance,
  params: { userId: string; userName: string; phone?: string | null; email?: string | null; avatarUrl?: string | null },
) {
  await app.db.execute(
    'UPDATE user_profiles SET user_name = ?, mob_number = ?, user_email = ?, avatar_url = ? WHERE id = ?',
    [params.userName, params.phone ?? null, params.email ?? null, params.avatarUrl ?? null, params.userId],
  );
}
