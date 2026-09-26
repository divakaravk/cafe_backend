import { z } from 'zod';

export const LoginBody = z.object({
  input: z.string().min(1),
  password: z.string().min(1),
  forceLogin: z.boolean().optional().default(false),
  deviceLabel: z.string().optional(),
});

export const RefreshBody = z.object({
  refresh_token: z.string().min(10),
});

export const LogoutBody = z.object({
  refresh_token: z.string().min(10).optional(),
});

export const ChangePasswordBody = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(6),
});
