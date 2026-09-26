import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { newId } from '../../lib/ids.js';
import * as itemsService from './service.js';

const ItemData = z.record(z.string(), z.unknown());

export default async function itemRoutes(app: FastifyInstance) {
  app.get('/items', { preHandler: app.authenticate }, async (req) => {
    const { order } = z.object({ order: z.enum(['display', 'name']).default('display') }).parse(req.query);
    return order === 'display' ? itemsService.getItemGroups(app, req.user.cid!) : itemsService.getAllItems(app, req.user.cid!);
  });

  app.get('/items/:id/variants', { preHandler: app.authenticate }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { sellable } = z.object({ sellable: z.coerce.boolean().default(false) }).parse(req.query);
    return itemsService.getVariantsByGroup(app, id, sellable);
  });

  app.put(
    '/items/:id',
    { preHandler: [app.authenticate, app.requirePerm('can_manage_items')] },
    async (req) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const body = z
        .object({ data: ItemData, create_default_variant: z.boolean().optional().default(false) })
        .parse(req.body);
      const result = await itemsService.saveItemGroup(app, req.user.cid!, { ...body.data, id });

      if (body.create_default_variant) {
        const variantId = newId();
        await itemsService.upsertVariant(app, {
          id: variantId,
          item_id: id,
          variant_name: 'Default',
          base_rate: 0,
          is_active: true,
          is_available: true,
          is_default: true,
          display_order: 0,
        }, req.user.cid!);
        await itemsService.setGroupDefaultVariantPointer(app, id, variantId, req.user.cid!);
        return { id, default_variant_id: variantId };
      }
      return result;
    },
  );

  app.delete('/items/:id', { preHandler: [app.authenticate, app.requirePerm('can_manage_items')] }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await itemsService.deleteItemMaster(app, id, req.user.cid!);
    return { ok: true };
  });

  app.put(
    '/variants/:id',
    { preHandler: [app.authenticate, app.requirePerm('can_manage_items')] },
    async (req) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const data = ItemData.parse(req.body);
      return itemsService.upsertVariant(app, { ...data, id }, req.user.cid!);
    },
  );

  app.delete(
    '/variants/:id',
    { preHandler: [app.authenticate, app.requirePerm('can_manage_items')] },
    async (req) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      await itemsService.deleteVariant(app, id, req.user.cid!);
      return { ok: true };
    },
  );

  app.post(
    '/items/:id/default-variant',
    { preHandler: [app.authenticate, app.requirePerm('can_manage_items')] },
    async (req) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const { variant_id } = z.object({ variant_id: z.string().uuid() }).parse(req.body);
      await itemsService.setDefaultVariant(app, id, variant_id, req.user.cid!);
      return { ok: true };
    },
  );

  // `PosBackend.setGroupDefaultVariantPointer` — a standalone route for a Dart
  // interface method the `PUT /items/:id` `create_default_variant` flow above
  // already calls internally as one step of a bigger atomic operation. Kept
  // separate here because item_master_screen.dart's `_save()` calls
  // `upsertVariant` then this as two independent steps outside that flow.
  app.post(
    '/items/:id/default-variant-pointer',
    { preHandler: [app.authenticate, app.requirePerm('can_manage_items')] },
    async (req) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const { variant_id } = z.object({ variant_id: z.string().uuid() }).parse(req.body);
      await itemsService.setGroupDefaultVariantPointer(app, id, variant_id, req.user.cid!);
      return { ok: true };
    },
  );
}
