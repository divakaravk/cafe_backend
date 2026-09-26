import { z } from 'zod';

export const CartItemInput = z.object({
  item_id: z.string().uuid(),
  variant_id: z.string().uuid().nullable().optional(),
  item_name: z.string().min(1),
  rate: z.number().nonnegative(),
  qty: z.number().positive(),
  gst_rate: z.number().nonnegative().default(0),
  is_taxable: z.boolean().default(true),
  hsn_code: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});

export const SaveOrderWithKotBody = z.object({
  table_id: z.string().uuid(),
  cover_id: z.string().uuid().nullable().optional(),
  cart: z.array(CartItemInput).min(1),
});

export const CreateSessionBody = z.object({
  table_id: z.string().uuid().nullable().optional(),
  order_type: z.string().default('DINING'),
});

export const CheckoutTableBody = z.object({
  payment_mode: z.string(),
  discount_percent: z.number().default(0),
});
