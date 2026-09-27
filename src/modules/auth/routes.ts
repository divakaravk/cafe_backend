import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { config } from '../../config.js';
import { Errors } from '../../plugins/errors.js';
import { LoginBody, RefreshBody, LogoutBody, ChangePasswordBody } from './schemas.js';
import * as authService from './service.js';

// Set only by the Flutter web build (native/desktop keep the refresh token in
// flutter_secure_storage and never send this) — see lib/core/backend/rest/token_store.dart.
const isWebClient = (req: { headers: Record<string, unknown> }) => req.headers['x-client-platform'] === 'web';

const REFRESH_COOKIE = 'refresh_token';
const cookiePath = '/v1/auth';

function setRefreshCookie(reply: FastifyReply, token: string) {
  reply.setCookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: config.NODE_ENV === 'production',
    sameSite: 'strict',
    path: cookiePath,
    maxAge: config.REFRESH_TTL_DAYS * 86400,
  });
}

function clearRefreshCookie(reply: FastifyReply) {
  reply.clearCookie(REFRESH_COOKIE, { path: cookiePath });
}

export default async function authRoutes(app: FastifyInstance) {
  app.post(
    '/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = LoginBody.parse(req.body);
      const result = await authService.login(app, {
        input: body.input,
        password: body.password,
        forceLogin: body.forceLogin,
        ip: req.ip,
        deviceLabel: body.deviceLabel,
      });
      if (isWebClient(req)) {
        setRefreshCookie(reply, result.refresh_token);
        const { refresh_token: _rt, ...rest } = result;
        return rest;
      }
      return result;
    },
  );

  app.post('/refresh', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = RefreshBody.parse(req.body ?? {});
    const token = body.refresh_token ?? (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
    if (!token) throw Errors.unauthorized('No refresh token provided.');

    const result = await authService.refresh(app, token);
    if (isWebClient(req)) {
      setRefreshCookie(reply, result.refresh_token);
      const { refresh_token: _rt, ...rest } = result;
      return rest;
    }
    return result;
  });

  app.post('/logout', async (req, reply) => {
    const body = LogoutBody.parse(req.body ?? {});
    const token = body.refresh_token ?? (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
    await authService.logout(app, token);
    if (isWebClient(req)) clearRefreshCookie(reply);
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
