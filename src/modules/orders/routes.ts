import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { runIdempotent } from '../../plugins/idempotency.js';
import { SaveOrderWithKotBody, CreateSessionBody, CheckoutTableBody } from './schemas.js';
import * as ordersService from './service.js';

export default async function orderRoutes(app: FastifyInstance) {
  app.post('/sessions', { preHandler: app.authenticate }, async (req) => {
    const body = CreateSessionBody.parse(req.body);
    return ordersService.createOrder(app, {
      companyId: req.user.cid!,
      tableId: body.table_id,
      openedBy: req.user.sub,
    });
  });

  app.post(
    '/orders/kot',
    { preHandler: [app.authenticate, app.requirePerm('can_create_bill')] },
    async (req, reply) => {
      const body = SaveOrderWithKotBody.parse(req.body);
      const { status, body: result } = await runIdempotent(app, req, 'orders.kot', () =>
        ordersService.saveOrderWithKot(app, {
          companyId: req.user.cid!,
          tableId: body.table_id,
          openedBy: req.user.sub,
          cart: body.cart,
          coverId: body.cover_id,
        }),
      );
      return reply.status(status).send(result);
    },
  );

  app.get('/tables/:id/order-summary', { preHandler: app.authenticate }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return ordersService.getOrderSummaryForTable(app, id, req.user.cid!);
  });

  app.post(
    '/tables/:id/checkout',
    { preHandler: [app.authenticate, app.requirePerm('can_create_bill')] },
    async (req, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const body = CheckoutTableBody.parse(req.body);
      const { status, body: result } = await runIdempotent(app, req, 'tables.checkout', async () => {
        await ordersService.checkoutTable(app, {
          tableId: id,
          companyId: req.user.cid!,
          paymentMode: body.payment_mode,
          discountPercent: body.discount_percent,
        });
        return { ok: true };
      });
      return reply.status(status).send(result);
    },
  );
}
