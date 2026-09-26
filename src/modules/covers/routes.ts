import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as coversService from './service.js';

export default async function coverRoutes(app: FastifyInstance) {
  app.get('/sessions/:id/covers', { preHandler: app.authenticate }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return coversService.getCoversForSession(app, id, req.user.cid!);
  });

  app.get('/sessions/:id/cover-totals', { preHandler: app.authenticate }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return coversService.getCoverTotals(app, id, req.user.cid!);
  });

  app.get('/sessions/:id/items', { preHandler: app.authenticate }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return coversService.getDetailedItemsForSession(app, id, req.user.cid!);
  });

  app.post('/sessions/:id/covers', { preHandler: app.authenticate }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z
      .object({ cover_number: z.number().int().positive(), label: z.string().nullable().optional(), pax: z.number().int().positive().default(1) })
      .parse(req.body);
    return coversService.createCover(app, {
      sessionId: id,
      companyId: req.user.cid!,
      coverNumber: body.cover_number,
      label: body.label,
      pax: body.pax,
    });
  });

  app.delete('/covers/:id', { preHandler: app.authenticate }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await coversService.deleteCover(app, id, req.user.cid!);
    return { ok: true };
  });

  app.post('/covers/:id/checkout', { preHandler: [app.authenticate, app.requirePerm('can_create_bill')] }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z
      .object({ session_id: z.string().uuid(), payment_mode: z.string().default('cash'), discount_percent: z.number().default(0) })
      .parse(req.body);
    await coversService.checkoutCover(app, {
      coverId: id,
      sessionId: body.session_id,
      companyId: req.user.cid!,
      paymentMode: body.payment_mode,
      discountPercent: body.discount_percent,
    });
    return { ok: true };
  });
}
