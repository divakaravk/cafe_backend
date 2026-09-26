import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as ownerService from './service.js';
import { registerSuperAdminDevice } from '../push/service.js';

/** Owner-only, unlike Supabase where these RPCs were reachable by `anon`
 * (docs/backend-migration/PLAN.md §1.3 finding #1 — anyone holding the anon
 * key could list every pending OTP and activate any company). */
export default async function ownerRoutes(app: FastifyInstance) {
  app.get(
    '/owner/registrations',
    { preHandler: [app.authenticate, app.requireRole('owner')] },
    async (req) => {
      const { limit } = z.object({ limit: z.coerce.number().int().positive().max(200).default(50) }).parse(req.query);
      return ownerService.listCompanyRegistrations(app, limit);
    },
  );

  app.post(
    '/owner/registrations/:id/approve',
    { preHandler: [app.authenticate, app.requireRole('owner')] },
    async (req) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      return ownerService.approveCompanyRegistration(app, id);
    },
  );

  app.put(
    '/owner/devices',
    { preHandler: [app.authenticate, app.requireRole('owner')] },
    async (req) => {
      const body = z.object({ token: z.string().min(10), label: z.string().nullable().optional() }).parse(req.body);
      await registerSuperAdminDevice(app, body.token, body.label);
      return { ok: true };
    },
  );
}
