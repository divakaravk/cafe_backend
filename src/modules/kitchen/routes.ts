import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as kitchenService from './service.js';

export default async function kitchenRoutes(app: FastifyInstance) {
  app.get('/kots', { preHandler: app.authenticate }, async (req) => {
    return kitchenService.getActiveKots(app, req.user.cid!);
  });

  app.patch('/kots/:id', { preHandler: app.authenticate }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { status } = z.object({ status: z.string() }).parse(req.body);
    await kitchenService.updateKotStatus(app, id, status, req.user.cid!);
    return { ok: true };
  });

  app.patch('/kot-items/:id', { preHandler: app.authenticate }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { status } = z.object({ status: z.string() }).parse(req.body);
    await kitchenService.updateKotItemStatus(app, id, status, req.user.cid!);
    return { ok: true };
  });
}
