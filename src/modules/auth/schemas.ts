import { z } from 'zod';

export const LoginBody = z.object({
  input: z.string().min(1),
  password: z.string().min(1),
  forceLogin: z.boolean().optional().default(false),
  deviceLabel: z.string().optional(),
});

export const RefreshBody = z.object({
  // Nullish (not just optional): a web client sends it via the httpOnly
  // `refresh_token` cookie instead (see routes.ts), and the Dart caller's
  // `String?` sometimes serializes as an explicit JSON `null` rather than an
  // absent key — `.optional()` alone rejects `null`, only `.nullish()` doesn't.
  refresh_token: z.string().min(10).nullish(),
});

export const LogoutBody = z.object({
  refresh_token: z.string().min(10).nullish(),
});

export const ChangePasswordBody = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(6),
});
