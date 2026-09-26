import type { Pool, PoolConnection } from 'mysql2/promise';

const RETRYABLE = new Set(['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT']);

/** Runs `fn` inside a transaction on its own connection, committing on success
 * and rolling back on any thrown error. Retries up to 3 times (with jitter) on
 * a deadlock or lock-wait-timeout — the two errors that mean "try again",
 * never on anything else. */
export async function withTransaction<T>(
  pool: Pool,
  fn: (conn: PoolConnection) => Promise<T>,
): Promise<T> {
  let attempt = 0;
  for (;;) {
    attempt++;
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const result = await fn(conn);
      await conn.commit();
      return result;
    } catch (err) {
      await conn.rollback().catch(() => {});
      const code = (err as { code?: string }).code;
      if (code && RETRYABLE.has(code) && attempt < 3) {
        await new Promise((r) => setTimeout(r, 20 * attempt + Math.random() * 30));
        continue;
      }
      throw err;
    } finally {
      conn.release();
    }
  }
}
