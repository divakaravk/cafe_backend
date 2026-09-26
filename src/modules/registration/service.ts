import { randomInt, createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { config } from '../../config.js';
import { newId } from '../../lib/ids.js';
import { withTransaction } from '../../lib/tx.js';
import { hashPassword } from '../../lib/argon.js';
import { Errors } from '../../plugins/errors.js';
import { sendRegistrationOtpPush } from '../push/service.js';
import type { z } from 'zod';
import type { CompanyInput, OwnerInput } from './schemas.js';

/** Port of the `request_company_registration` RPC (supabase_company_registration.sql):
 * creates the company unverified/inactive plus a registration row carrying a
 * fresh 6-digit OTP, then fires the (best-effort, guarded) push — replacing
 * the Postgres `company_registration_otp_push` trigger + DB webhook. */
export async function requestCompanyRegistration(
  app: FastifyInstance,
  params: { company: z.infer<typeof CompanyInput>; owner: z.infer<typeof OwnerInput> },
) {
  const companyId = newId();
  const registrationId = newId();
  const otp = String(randomInt(0, 1_000_000)).padStart(6, '0');

  await withTransaction(app.db, async (conn) => {
    await conn.execute(
      `INSERT INTO company_master
         (id, company_code, company_name, email, phone, address, city, state, country,
          has_gst, gstin, pan_number, has_table_management, has_item_variants, show_item_images,
          is_active, is_verified)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`,
      [
        companyId, params.company.company_code, params.company.company_name, params.company.email ?? null,
        params.company.phone ?? null, params.company.address ?? null, params.company.city ?? null,
        params.company.state ?? null, params.company.country, params.company.has_gst, params.company.gstin ?? null,
        params.company.pan_number ?? null, params.company.has_table_management, params.company.has_item_variants,
        params.company.show_item_images,
      ],
    );
    await conn.execute(
      `INSERT INTO company_registration
         (id, company_id, company_name, owner_name, owner_email, owner_phone, otp_code, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        registrationId, companyId, params.company.company_name, params.owner.owner_name ?? null,
        params.owner.owner_email ?? null, params.owner.owner_phone ?? null, otp, new Date(Date.now() + 10 * 60 * 1000),
      ],
    );
  });

  await sendRegistrationOtpPush(app, { otp, companyName: params.company.company_name });

  return { registration_id: registrationId, company_id: companyId };
}

interface RegistrationRow {
  id: string;
  company_id: string;
  otp_code: string;
  status: string;
  attempts: number;
  expires_at: Date;
}

/** Port of `verify_company_registration_otp` — same order of checks (wrong
 * code first, even on an already-verified row; then expiry; then success). */
export async function verifyCompanyRegistrationOtp(app: FastifyInstance, registrationId: string, code: string) {
  return withTransaction(app.db, async (conn) => {
    const [rows] = await conn.query('SELECT * FROM company_registration WHERE id = ? FOR UPDATE', [registrationId]);
    const reg = (rows as RegistrationRow[])[0];
    if (!reg) return { ok: false, reason: 'not_found' };

    if (reg.otp_code !== code) {
      if (reg.status === 'pending') {
        await conn.execute('UPDATE company_registration SET attempts = attempts + 1 WHERE id = ?', [registrationId]);
        if (reg.attempts + 1 >= 5) return { ok: false, reason: 'too_many_attempts' };
      }
      return { ok: false, reason: 'invalid' };
    }

    if (reg.status === 'pending' && new Date() > new Date(reg.expires_at)) {
      await conn.execute("UPDATE company_registration SET status = 'expired' WHERE id = ?", [registrationId]);
      return { ok: false, reason: 'expired' };
    }

    await conn.execute("UPDATE company_registration SET status = 'verified' WHERE id = ?", [registrationId]);
    await conn.execute('UPDATE company_master SET is_verified = 1, is_active = 1 WHERE id = ?', [reg.company_id]);

    return { ok: true, company_id: reg.company_id };
  });
}

/** Mints a short-lived, single-purpose token proving this caller just verified
 * this exact registration — the "registration token" the plan's endpoint map
 * calls for, without needing a schema change to store one.
 *
 * Deliberately NOT `app.jwt.sign` — that instance's payload type is pinned to
 * [[AccessTokenPayload]] (see plugins/auth.ts's `FastifyJWT` augmentation) for
 * every *login* session, and this is a different, one-off token type with a
 * different lifetime and purpose. A tiny HMAC-signed token keeps the two
 * concerns from tangling, at the cost of ~10 lines instead of a shared union
 * type threaded through every route that reads `req.user`. */
export function issueRegistrationToken(registrationId: string, companyId: string): string {
  const body = Buffer.from(JSON.stringify({ rid: registrationId, cid: companyId, exp: Date.now() + 15 * 60 * 1000 })).toString(
    'base64url',
  );
  const sig = createHmac('sha256', config.JWT_ACCESS_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyRegistrationToken(token: string, registrationId: string): string {
  const [body, sig] = token.split('.');
  if (!body || !sig) throw Errors.unauthorized('Invalid registration token.');
  const expected = createHmac('sha256', config.JWT_ACCESS_SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw Errors.unauthorized('Invalid registration token.');

  const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as { rid: string; cid: string; exp: number };
  if (Date.now() > payload.exp) throw Errors.unauthorized('Registration token expired.');
  if (payload.rid !== registrationId) throw Errors.unauthorized('Invalid registration token.');
  return payload.cid;
}

/** Creates the first admin for a just-verified registration. Requires the
 * token `verifyCompanyRegistrationOtp`'s caller received — nobody else can
 * mint one for this registration id. */
export async function createFirstAdmin(
  app: FastifyInstance,
  params: {
    registrationId: string;
    registrationToken: string;
    user: { user_name: string; employee_code: string; username: string; password: string; mob_number?: string | null; user_email?: string | null };
  },
) {
  const companyId = verifyRegistrationToken(params.registrationToken, params.registrationId);
  const [company] = await app.db.query('SELECT is_verified FROM company_master WHERE id = ?', [companyId]);
  if (!(company as { is_verified: boolean }[])[0]?.is_verified) {
    throw Errors.badRequest('Company is not verified yet.');
  }

  const id = newId();
  const passwordHash = await hashPassword(params.user.password);
  await withTransaction(app.db, async (conn) => {
    await conn.execute(
      `INSERT INTO user_profiles (id, company_id, employee_code, user_name, username, password_hash, user_role, mob_number, user_email)
       VALUES (?, ?, ?, ?, ?, ?, 'admin', ?, ?)`,
      [id, companyId, params.user.employee_code, params.user.user_name, params.user.username, passwordHash, params.user.mob_number ?? null, params.user.user_email ?? null],
    );
    await conn.execute(
      `INSERT INTO user_permission (id, user_id, can_view_dashboard, can_create_bill, can_edit_bill, can_cancel_bill,
         can_apply_discount, can_manage_items, can_manage_tables, can_view_reports, can_manage_users,
         can_manage_settings, can_void_items, can_manage_stock)
       VALUES (?, ?, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1)`,
      [newId(), id],
    );
  });
  return { id, company_id: companyId };
}
