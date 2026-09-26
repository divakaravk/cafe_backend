import { z } from 'zod';

const ROLES = ['owner', 'admin', 'manager', 'cashier', 'waiter', 'kitchen'] as const;

export const UserInput = z.object({
  id: z.string().uuid().optional(),
  company_id: z.string().uuid().nullable().optional(),
  user_name: z.string().min(1),
  employee_code: z.string().min(1),
  username: z.string().min(1),
  user_role: z.enum(ROLES),
  mob_number: z.string().nullable().optional(),
  user_email: z.string().email().nullable().optional().or(z.literal('').transform(() => null)),
  user_active: z.boolean().optional().default(true),
  avatar_url: z.string().nullable().optional(),
  /** Plaintext — hashed server-side. Omit on update to leave the password unchanged. */
  password: z.string().min(1).optional(),
});

export const PermissionInput = z.object({
  can_view_dashboard: z.boolean().default(false),
  can_create_bill: z.boolean().default(true),
  can_edit_bill: z.boolean().default(false),
  can_cancel_bill: z.boolean().default(false),
  can_apply_discount: z.boolean().default(false),
  can_manage_items: z.boolean().default(false),
  can_manage_tables: z.boolean().default(false),
  can_view_reports: z.boolean().default(false),
  can_manage_users: z.boolean().default(false),
  can_manage_settings: z.boolean().default(false),
  can_void_items: z.boolean().default(false),
  can_manage_stock: z.boolean().default(false),
});

export const UpsertUserBody = z.object({
  user: UserInput,
  permissions: PermissionInput,
});

export const UpdateOwnProfileBody = z.object({
  user_name: z.string().min(1),
  mob_number: z.string().nullable().optional(),
  user_email: z.string().nullable().optional(),
  avatar_url: z.string().nullable().optional(),
});
