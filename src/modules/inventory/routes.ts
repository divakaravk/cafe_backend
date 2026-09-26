import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as inventoryService from './service.js';

const MaterialData = z.record(z.string(), z.unknown());

export default async function inventoryRoutes(app: FastifyInstance) {
  app.get('/inventory/materials', { preHandler: app.authenticate }, async (req) => {
    return inventoryService.getRawMaterials(app, req.user.cid!);
  });

  app.put(
    '/inventory/materials/:id',
    { preHandler: [app.authenticate, app.requirePerm('can_manage_stock')] },
    async (req) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const data = MaterialData.parse(req.body);
      return inventoryService.upsertRawMaterial(app, req.user.cid!, { ...data, id });
    },
  );

  app.delete(
    '/inventory/materials/:id',
    { preHandler: [app.authenticate, app.requirePerm('can_manage_stock')] },
    async (req) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      await inventoryService.deleteRawMaterial(app, id, req.user.cid!);
      return { ok: true };
    },
  );

  app.get('/inventory/materials/:id/recipe-usage', { preHandler: app.authenticate }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return { count: await inventoryService.countRecipeLinesUsingMaterial(app, id, req.user.cid!) };
  });

  app.get('/inventory/recipes', { preHandler: app.authenticate }, async (req) => {
    const { variant_id } = z.object({ variant_id: z.string().uuid() }).parse(req.query);
    return inventoryService.getRecipeForVariant(app, variant_id, req.user.cid!);
  });

  app.put(
    '/inventory/recipes/:id',
    { preHandler: [app.authenticate, app.requirePerm('can_manage_stock')] },
    async (req) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const data = MaterialData.parse(req.body);
      return inventoryService.upsertRecipeLine(app, { ...data, id }, req.user.cid!);
    },
  );

  app.delete(
    '/inventory/recipes/:id',
    { preHandler: [app.authenticate, app.requirePerm('can_manage_stock')] },
    async (req) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      await inventoryService.deleteRecipeLine(app, id, req.user.cid!);
      return { ok: true };
    },
  );

  app.get('/inventory/stock', { preHandler: app.authenticate }, async (req) => {
    return inventoryService.getCurrentStock(app, req.user.cid!);
  });

  app.get('/inventory/staff-consumption', { preHandler: app.authenticate }, async (req) => {
    const q = z
      .object({
        from: z.coerce.date().optional(),
        to: z.coerce.date().optional(),
        staff_id: z.string().uuid().optional(),
      })
      .parse(req.query);
    return inventoryService.getStaffConsumption(app, req.user.cid!, { from: q.from, to: q.to, staffId: q.staff_id });
  });

  app.post(
    '/inventory/adjustments',
    { preHandler: [app.authenticate, app.requirePerm('can_manage_stock')] },
    async (req) => {
      const body = z
        .object({
          raw_material_id: z.string().uuid(),
          qty: z.number(),
          movement_type: z.string().default('adjustment'),
          note: z.string().nullable().optional(),
          shift_label: z.string().nullable().optional(),
          staff_id: z.string().uuid().nullable().optional(),
        })
        .parse(req.body);
      await inventoryService.submitStockAdjustment(app, {
        companyId: req.user.cid!,
        rawMaterialId: body.raw_material_id,
        qty: body.qty,
        movementType: body.movement_type,
        note: body.note,
        shiftLabel: body.shift_label,
        staffId: body.staff_id,
      });
      return { ok: true };
    },
  );
}
