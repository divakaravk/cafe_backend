import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Errors } from './errors.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function hashBody(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body ?? {})).digest('hex');
}

/** Wraps a mutating route handler so a client retry (same `Idempotency-Key`
 * header, e.g. after the app's 15–25s `safeApiCall` timeout fires but the
 * server actually finished) replays the first response instead of creating a
 * second bill/KOT. See docs/backend-migration/PLAN.md §4.3/§6.1.
 *
 * No header -> runs [handler] plainly (idempotency is opt-in per call, not a
 * blanket requirement). */
export async function runIdempotent(
  app: FastifyInstance,
  req: FastifyRequest,
  endpoint: string,
  handler: () => Promise<unknown>,
): Promise<{ status: number; body: unknown }> {
  const key = req.headers['idempotency-key'];
  if (!key || Array.isArray(key)) return { status: 200, body: await handler() };
  if (!UUID_RE.test(key)) throw Errors.badRequest('Idempotency-Key must be a UUID.');

  const userId = req.user.sub;
  const requestHash = hashBody(req.body);

  try {
    await app.db.execute(
      'INSERT INTO idempotency_key (user_id, idem_key, endpoint, request_hash) VALUES (?, ?, ?, ?)',
      [userId, key, endpoint, requestHash],
    );
  } catch (err) {
    if ((err as { code?: string }).code !== 'ER_DUP_ENTRY') throw err;

    const [rows] = await app.db.query(
      'SELECT endpoint, request_hash, response_status, response_body FROM idempotency_key WHERE user_id = ? AND idem_key = ?',
      [userId, key],
    );
    const row = (rows as { endpoint: string; request_hash: string; response_status: number | null; response_body: unknown }[])[0];
    if (!row) throw err; // raced with a purge — vanishingly unlikely; let the caller retry

    if (row.endpoint !== endpoint || row.request_hash !== requestHash) {
      throw Errors.conflict(
        'This Idempotency-Key was already used for a different request.',
        'IDEMPOTENCY_KEY_REUSED',
      );
    }
    if (row.response_status === null) {
      throw Errors.conflict('This request is already being processed.', 'IDEMPOTENCY_IN_PROGRESS');
    }
    return { status: row.response_status, body: row.response_body };
  }

  try {
    const body = await handler();
    await app.db.execute(
      'UPDATE idempotency_key SET response_status = 200, response_body = CAST(? AS JSON) WHERE user_id = ? AND idem_key = ?',
      [JSON.stringify(body ?? null), userId, key],
    );
    return { status: 200, body };
  } catch (err) {
    // Nothing succeeded — free the key so a real retry isn't permanently blocked.
    await app.db
      .execute('DELETE FROM idempotency_key WHERE user_id = ? AND idem_key = ?', [userId, key])
      .catch(() => {});
    throw err;
  }
}

/** Purges idempotency rows past their TTL. Call on an interval from server.ts. */
export async function purgeExpiredIdempotencyKeys(app: FastifyInstance, ttlHours: number) {
  await app.db.execute(
    'DELETE FROM idempotency_key WHERE created_at < (NOW() - INTERVAL ? HOUR)',
    [ttlHours],
  );
}
