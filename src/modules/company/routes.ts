import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Errors } from '../../plugins/errors.js';

const UpdateCompanyBody = z.object({
  company_name: z.string().min(1).optional(),
  address: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  has_gst: z.boolean().optional(),
  gstin: z.string().nullable().optional(),
  pan_number: z.string().nullable().optional(),
  has_table_management: z.boolean().optional(),
  has_item_variants: z.boolean().optional(),
  currency_code: z.string().optional(),
  timezone: z.string().optional(),
  logo_url: z.string().nullable().optional(),
  show_item_images: z.boolean().optional(),
});

/** Resolves the target company: the caller's own (from the JWT), unless
 * they're the platform owner, who may address any company by id. Tenant
 * isolation lives here, not in the request body (docs/backend-migration/PLAN.md §4.1). */
function targetCompanyId(req: { user: { cid: string | null; role: string } }, paramId?: string): string {
  if (req.user.role === 'owner' && paramId) return paramId;
  if (!req.user.cid) throw Errors.forbidden('No company associated with this account.');
  return req.user.cid;
}

export default async function companyRoutes(app: FastifyInstance) {
  app.get('/company', { preHandler: app.authenticate }, async (req) => {
    const id = targetCompanyId(req);
    const [rows] = await app.db.query('SELECT * FROM company_master WHERE id = ?', [id]);
    return (rows as unknown[])[0] ?? null;
  });

  app.get('/companies/:id', { preHandler: [app.authenticate, app.requireRole('owner')] }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const [rows] = await app.db.query('SELECT * FROM company_master WHERE id = ?', [id]);
    return (rows as unknown[])[0] ?? null;
  });

  app.patch('/company', { preHandler: [app.authenticate, app.requirePerm('can_manage_settings')] }, async (req) => {
    const id = targetCompanyId(req);
    const body = UpdateCompanyBody.parse(req.body);
    const entries = Object.entries(body).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return { ok: true };
    const sets = entries.map(([k]) => `${k} = ?`).join(', ');
    const values = entries.map(([, v]) => v);
    await app.db.execute(`UPDATE company_master SET ${sets} WHERE id = ?`, [...values, id]);
    return { ok: true };
  });

  app.get('/company/hsn', { preHandler: app.authenticate }, async (req) => {
    const id = targetCompanyId(req);
    const [rows] = await app.db.query('SELECT * FROM company_hsn WHERE company_id = ? ORDER BY hsn_code', [id]);
    return rows;
  });
}
