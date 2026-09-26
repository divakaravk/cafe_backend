import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { runIdempotent } from '../../plugins/idempotency.js';
import * as billsService from './service.js';

const BillItemInput = z.object({
  item_id: z.string().uuid().nullable().optional(),
  variant_id: z.string().uuid().nullable().optional(),
  item_name: z.string().nullable().optional(),
  rate: z.number(),
  qty: z.number(),
  gst_rate: z.number().nullable().optional(),
  is_taxable: z.boolean().nullable().optional(),
  hsn_code: z.string().nullable().optional(),
  discount_item: z.number().nullable().optional(),
  notes: z.string().nullable().optional(),
});

const CreateBillBody = z.object({
  table_session_id: z.string().uuid().nullable().optional(),
  subtotal: z.number(),
  discount_amount: z.number().default(0),
  discount_type: z.string().nullable().optional(),
  total_amount: z.number(),
  payment_mode: z.string().default('cash'),
  bill_type: z.string().default('dine_in'),
  bill_items: z.array(BillItemInput).min(1),
});

export default async function billRoutes(app: FastifyInstance) {
  app.post(
    '/bills',
    { preHandler: [app.authenticate, app.requirePerm('can_create_bill')] },
    async (req, reply) => {
      const body = CreateBillBody.parse(req.body);
      const { status, body: result } = await runIdempotent(app, req, 'bills.create', () =>
        billsService.createBill(app, {
          companyId: req.user.cid!,
          billedBy: req.user.sub,
          tableSessionId: body.table_session_id,
          subtotal: body.subtotal,
          discountAmount: body.discount_amount,
          discountType: body.discount_type,
          totalAmount: body.total_amount,
          paymentMode: body.payment_mode,
          billType: body.bill_type,
          billItems: body.bill_items,
        }),
      );
      return reply.status(status).send(result);
    },
  );

  app.get('/bills', { preHandler: [app.authenticate, app.requirePerm('can_view_reports')] }, async (req) => {
    const q = z
      .object({
        from: z.coerce.date().optional(),
        to: z.coerce.date().optional(),
        limit: z.coerce.number().int().positive().max(5000).optional(),
      })
      .parse(req.query);
    return billsService.getBills(app, req.user.cid!, { startDate: q.from, endDate: q.to, limit: q.limit });
  });

  app.post(
    '/bills/:id/cancel',
    { preHandler: [app.authenticate, app.requirePerm('can_cancel_bill')] },
    async (req) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const { reason } = z.object({ reason: z.string().nullable().optional() }).parse(req.body ?? {});
      await billsService.cancelBill(app, { billId: id, companyId: req.user.cid!, reason, userId: req.user.sub });
      return { ok: true };
    },
  );

  app.patch(
    '/bills/:id',
    { preHandler: [app.authenticate, app.requirePerm('can_edit_bill')] },
    async (req) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const body = z
        .object({
          items: z.array(z.object({ id: z.string().uuid(), qty: z.number(), rate: z.number(), gst_rate: z.number().optional() })),
          removed_item_ids: z.array(z.string().uuid()).default([]),
          discount_amount: z.number().default(0),
        })
        .parse(req.body);
      await billsService.updateBill(app, {
        billId: id,
        companyId: req.user.cid!,
        userId: req.user.sub,
        items: body.items,
        removedItemIds: body.removed_item_ids,
        discountAmount: body.discount_amount,
      });
      return { ok: true };
    },
  );
}
