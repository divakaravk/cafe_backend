import type { FastifyInstance } from 'fastify';
import { withTransaction } from '../../lib/tx.js';

export async function listCompanyRegistrations(app: FastifyInstance, limit: number) {
  const [rows] = await app.db.query('SELECT * FROM company_registration ORDER BY created_at DESC LIMIT ?', [limit]);
  return rows;
}

/** Port of `approve_company_registration` — owner override that activates a
 * company without the OTP round-trip. */
export async function approveCompanyRegistration(app: FastifyInstance, registrationId: string) {
  return withTransaction(app.db, async (conn) => {
    const [result] = await conn.execute(
      "UPDATE company_registration SET status = 'verified' WHERE id = ?",
      [registrationId],
    );
    if ((result as { affectedRows: number }).affectedRows === 0) return { ok: false, reason: 'not_found' };

    const [rows] = await conn.query('SELECT company_id FROM company_registration WHERE id = ?', [registrationId]);
    const companyId = (rows as { company_id: string }[])[0]?.company_id;
    if (!companyId) return { ok: false, reason: 'not_found' };

    await conn.execute('UPDATE company_master SET is_verified = 1, is_active = 1 WHERE id = ?', [companyId]);
    return { ok: true, company_id: companyId };
  });
}
