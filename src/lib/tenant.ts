import type { FastifyInstance } from 'fastify';
import { Errors } from '../plugins/errors.js';

/** "Tenant from the token, never the request" (docs/backend-migration/PLAN.md
 * §4.1.2) covers *listing* and *creating* — every route here already filters
 * `WHERE company_id = ?` or forces `company_id` on insert. It does NOT by
 * itself stop someone from *mutating an existing row by :id* that belongs to
 * a different company: `admin`/`owner` bypass `requirePerm` outright, and
 * nothing else was checking which row they were touching. A cross-company
 * force-logout attempt in scripts/smoke.mjs caught exactly this gap.
 *
 * `sql` must return one row shaped `{ company_id }` for `id` (a direct column
 * or a join to the owning parent — see call sites for both patterns). */
async function ownerCompanyOf(app: FastifyInstance, sql: string, id: string): Promise<string | null | undefined> {
  const [rows] = await app.db.query(sql, [id]);
  return (rows as { company_id: string | null }[])[0]?.company_id;
}

/** For read/update/delete of a resource that MUST already exist: 404 if it
 * doesn't, 403 if it belongs to someone else. */
export async function assertOwnedByCompany(
  app: FastifyInstance,
  sql: string,
  id: string,
  companyId: string,
  label = 'Resource',
): Promise<void> {
  const owner = await ownerCompanyOf(app, sql, id);
  if (owner === undefined) throw Errors.notFound(label);
  if (owner !== companyId) throw Errors.forbidden();
}

/** For an upsert-by-client-supplied-id: a brand-new id is fine (nothing to
 * own yet), but an id that already belongs to another company must never be
 * silently repointed to the caller's — that would let one tenant hijack
 * another's row outright. */
export async function assertNoHijack(
  app: FastifyInstance,
  sql: string,
  id: string,
  companyId: string,
  label = 'record',
): Promise<void> {
  const owner = await ownerCompanyOf(app, sql, id);
  if (owner !== undefined && owner !== companyId) {
    throw Errors.forbidden(`Cannot take over another company's ${label}.`);
  }
}
