import fp from 'fastify-plugin';
import fastifyJwt from '@fastify/jwt';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { Errors } from './errors.js';

export interface AccessTokenPayload {
  sub: string; // user id
  cid: string | null; // company id (null for the platform owner)
  role: string;
  sid: string; // auth_session id (so a specific device's tokens can be revoked)
  tv: number; // token_version at issue time
}

// The documented @fastify/jwt extension point (see its index.d.ts): augment
// `FastifyJWT`, not `FastifyRequest.user` directly — the latter is already
// declared by the plugin itself and would conflict.
declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: AccessTokenPayload;
    user: AccessTokenPayload;
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireRole: (...roles: string[]) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

interface CacheEntry {
  tokenVersion: number;
  active: boolean;
  expiresAt: number;
}

// 10-second cache so a force-logout / password change / deactivation takes
// effect within ~10s of the next request, without a DB round-trip on every
// single authenticated call (see docs/backend-migration/PLAN.md §4.5).
const TOKEN_VERSION_CACHE_MS = 10_000;
const cache = new Map<string, CacheEntry>();

export default fp(async function authPlugin(app: FastifyInstance) {
  await app.register(fastifyJwt, {
    secret: config.JWT_ACCESS_SECRET,
    sign: { expiresIn: config.ACCESS_TTL },
  });

  app.decorate('authenticate', async (req: FastifyRequest) => {
    let payload: AccessTokenPayload;
    try {
      payload = await req.jwtVerify<AccessTokenPayload>();
    } catch {
      throw Errors.unauthorized('Invalid or expired token.');
    }

    let entry = cache.get(payload.sub);
    if (!entry || entry.expiresAt < Date.now()) {
      const [rows] = await app.db.query(
        'SELECT token_version, user_active FROM user_profiles WHERE id = ?',
        [payload.sub],
      );
      const row = (rows as { token_version: number; user_active: boolean }[])[0];
      if (!row) throw Errors.unauthorized('Account no longer exists.');
      entry = {
        tokenVersion: row.token_version,
        active: row.user_active,
        expiresAt: Date.now() + TOKEN_VERSION_CACHE_MS,
      };
      cache.set(payload.sub, entry);
    }

    if (!entry.active) throw Errors.unauthorized('Your account is inactive. Contact your administrator.');
    if (entry.tokenVersion !== payload.tv) {
      throw Errors.unauthorized('Your session has ended. Please sign in again.');
    }

    req.user = payload;
  });

  app.decorate('requireRole', (...roles: string[]) => {
    return async (req: FastifyRequest) => {
      if (!roles.includes(req.user.role)) {
        throw Errors.forbidden();
      }
    };
  });
});

/** Call after any action that must invalidate a user's live tokens immediately
 * (force-logout, password change, deactivation) — bumping `token_version` in
 * the DB alone would still let the cache serve a stale "valid" answer for up
 * to `TOKEN_VERSION_CACHE_MS`. */
export function invalidateAuthCache(userId: string) {
  cache.delete(userId);
}
