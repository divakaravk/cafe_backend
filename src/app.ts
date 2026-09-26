import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { config } from './config.js';
import dbPlugin from './plugins/db.js';
import authPlugin from './plugins/auth.js';
import rbacPlugin from './plugins/rbac.js';
import errorsPlugin from './plugins/errors.js';
import healthRoutes from './modules/health/routes.js';
import authRoutes from './modules/auth/routes.js';
import userRoutes from './modules/users/routes.js';
import companyRoutes from './modules/company/routes.js';
import itemRoutes from './modules/items/routes.js';
import tableRoutes from './modules/tables/routes.js';
import coverRoutes from './modules/covers/routes.js';
import orderRoutes from './modules/orders/routes.js';
import billRoutes from './modules/bills/routes.js';
import kitchenRoutes from './modules/kitchen/routes.js';
import inventoryRoutes from './modules/inventory/routes.js';
import registrationRoutes from './modules/registration/routes.js';
import ownerRoutes from './modules/owner/routes.js';
import uploadRoutes from './modules/uploads/routes.js';

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      transport: config.NODE_ENV === 'development' ? { target: 'pino-pretty' } : undefined,
    },
    trustProxy: true,
    genReqId: () => crypto.randomUUID(),
  });

  // Fastify's default JSON parser rejects a truly empty body even when a
  // client sends `Content-Type: application/json` on a bodyless call (e.g.
  // `POST /users/:id/force-logout`, `DELETE /inventory/materials/:id`) — a
  // request shape every HTTP client eventually produces, including the
  // Flutter `RestBackend` (docs/backend-migration/PLAN.md Phase 6). Treat an
  // empty body as `{}` instead of a parse error.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    if (typeof body === 'string' && body.trim() === '') return done(null, {});
    try {
      done(null, JSON.parse(body as string));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  await app.register(helmet, { global: true });
  await app.register(cors, {
    origin: config.corsOrigins.length ? config.corsOrigins : true,
    credentials: true,
  });
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    // Auth endpoints get a tighter limit registered per-route (see modules/auth/routes.ts).
    //
    // Keyed by the caller's OWN user id when a bearer token is present, not
    // by IP. Caught by load-testing (docs/backend-migration/PLAN.md §8): the
    // default IP-keyed limiter meant every device behind one NAT'd IP —
    // realistic for mobile-data connections in India, and for two unrelated
    // café tenants that happen to share an ISP's carrier-grade NAT — shares
    // ONE 300/min budget, so one busy café could 429 a completely different
    // company's devices. This is a peek at the JWT payload for BUCKETING
    // ONLY, not authentication — an unverified/forged token just buckets the
    // caller under an id they don't control the effects of, which is
    // harmless; real authorization still runs through `app.authenticate`.
    keyGenerator: (req) => {
      const auth = req.headers.authorization;
      if (auth?.startsWith('Bearer ')) {
        try {
          const payload = auth.slice(7).split('.')[1] ?? '';
          const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { sub?: string };
          if (decoded.sub) return `user:${decoded.sub}`;
        } catch {
          // malformed token — the route itself will 401; fall back to IP for rate-limit purposes
        }
      }
      return `ip:${req.ip}`;
    },
  });
  await app.register(multipart, {
    limits: { fileSize: 8 * 1024 * 1024 }, // 8 MB — comfortably above the live avg (471 KB) / max (1.35 MB) image size
  });

  if (config.STORAGE_DRIVER === 'local') {
    const uploadRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', config.UPLOAD_DIR);
    await mkdir(uploadRoot, { recursive: true });
    await app.register(fastifyStatic, {
      root: uploadRoot,
      prefix: '/uploads/',
      // Content-hash filenames (src/modules/uploads/routes.ts) mean a URL's
      // bytes never change, so this is safe to cache forever.
      cacheControl: true,
      maxAge: '365d',
      immutable: true,
    });
  }

  await app.register(errorsPlugin);
  await app.register(dbPlugin);
  await app.register(authPlugin);
  await app.register(rbacPlugin);

  await app.register(healthRoutes);
  await app.register(authRoutes, { prefix: '/v1/auth' });
  await app.register(userRoutes, { prefix: '/v1' });
  await app.register(companyRoutes, { prefix: '/v1' });
  await app.register(itemRoutes, { prefix: '/v1' });
  await app.register(tableRoutes, { prefix: '/v1' });
  await app.register(coverRoutes, { prefix: '/v1' });
  await app.register(orderRoutes, { prefix: '/v1' });
  await app.register(billRoutes, { prefix: '/v1' });
  await app.register(kitchenRoutes, { prefix: '/v1' });
  await app.register(inventoryRoutes, { prefix: '/v1' });
  await app.register(registrationRoutes, { prefix: '/v1' });
  await app.register(ownerRoutes, { prefix: '/v1' });
  await app.register(uploadRoutes, { prefix: '/v1' });

  return app;
}
