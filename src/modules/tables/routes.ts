import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as tablesService from './service.js';

const TableBody = z.object({
  table_number: z.string().min(1),
  section: z.string().nullable().optional(),
  seating_capacity: z.number().int().positive(),
  is_active: z.boolean().optional().default(true),
});

export default async function tableRoutes(app: FastifyInstance) {
  app.get('/tables', { preHandler: app.authenticate }, async (req) => {
    return tablesService.getTables(app, req.user.cid!);
  });

  app.post(
    '/tables',
    { preHandler: [app.authenticate, app.requirePerm('can_manage_tables')] },
    async (req) => {
      const body = TableBody.parse(req.body);
      return tablesService.createTable(app, {
        companyId: req.user.cid!,
        tableNumber: body.table_number,
        section: body.section,
        seatingCapacity: body.seating_capacity,
        isActive: body.is_active,
      });
    },
  );

  app.patch(
    '/tables/:id',
    { preHandler: [app.authenticate, app.requirePerm('can_manage_tables')] },
    async (req) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const body = TableBody.parse(req.body);
      await tablesService.updateTable(app, {
        id,
        companyId: req.user.cid!,
        tableNumber: body.table_number,
        section: body.section,
        seatingCapacity: body.seating_capacity,
        isActive: body.is_active,
      });
      return { ok: true };
    },
  );

  app.get('/tables/:id/occupied', { preHandler: app.authenticate }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return { occupied: await tablesService.isTableOccupied(app, id, req.user.cid!) };
  });
}
