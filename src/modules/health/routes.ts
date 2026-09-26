import type { FastifyInstance } from 'fastify';

export default async function healthRoutes(app: FastifyInstance) {
  app.get('/healthz', async () => ({ ok: true }));

  app.get('/readyz', async (_req, reply) => {
    try {
      await app.db.query('SELECT 1');
      return { ok: true };
    } catch {
      return reply.status(503).send({ ok: false });
    }
  });

  // Server clock — the Dart client anchors elapsed-time displays (table
  // occupancy) to this instead of the device clock. Mirrors Supabase's
  // `server_now()` RPC exactly.
  app.get('/v1/time', async () => ({ now: new Date().toISOString() }));
}
