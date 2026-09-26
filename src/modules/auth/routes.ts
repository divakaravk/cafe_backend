import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { LoginBody, RefreshBody, LogoutBody, ChangePasswordBody } from './schemas.js';
import * as authService from './service.js';

export default async function authRoutes(app: FastifyInstance) {
  app.post(
    '/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req) => {
      const body = LoginBody.parse(req.body);
      return authService.login(app, {
        input: body.input,
        password: body.password,
        forceLogin: body.forceLogin,
        ip: req.ip,
        deviceLabel: body.deviceLabel,
      });
    },
  );

  app.post('/refresh', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const body = RefreshBody.parse(req.body);
    return authService.refresh(app, body.refresh_token);
  });

  app.post('/logout', async (req) => {
    const body = LogoutBody.parse(req.body ?? {});
    await authService.logout(app, body.refresh_token);
    return { ok: true };
  });

  // `PosBackend.setLoginStatus(userId, isLogin)` — the Dart caller always
  // passes its own id (see providers.dart's `AuthNotifier.signOut`), so this
  // only ever acts on the authenticated caller, regardless of what's passed.
  app.post('/login-status', { preHandler: app.authenticate }, async (req) => {
    const body = z.object({ is_login: z.boolean() }).parse(req.body);
    await authService.setLoginStatus(app, req.user.sub, body.is_login);
    return { ok: true };
  });

  app.get('/session', { preHandler: app.authenticate }, async (req) => {
    const status = await authService.getSessionStatus(app, req.user.sub);
    return status ?? {};
  });

  app.post('/change-password', { preHandler: app.authenticate }, async (req) => {
    const body = ChangePasswordBody.parse(req.body);
    const ok = await authService.changePassword(app, {
      userId: req.user.sub,
      currentPassword: body.currentPassword,
      newPassword: body.newPassword,
    });
    return { ok };
  });
}
