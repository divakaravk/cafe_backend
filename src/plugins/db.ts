import mysql, { type Pool, type FieldPacket } from 'mysql2/promise';
import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: Pool;
  }
}

/** TINYINT(1) -> real boolean; everything else passes through untouched.
 *
 * MUST call `next()` first and convert its result — calling `field.string()`
 * instead (the "obvious" version) silently corrupts the NEXT column read on
 * the binary protocol (verified while building docs/backend-migration/PLAN.md
 * §3.4: a following BIGINT came back as garbage). This is the safe pattern,
 * proven under both `execute` (binary) and `query` (text) protocols. */
function typeCast(field: FieldPacket & { type: string; length: number }, next: () => unknown) {
  const value = next();
  if (field.type === 'TINY' && field.length === 1 && value !== null) {
    return value === 1 || value === '1';
  }
  return value;
}

export function createPool(): Pool {
  const pool = mysql.createPool({
    host: config.DB_HOST,
    port: config.DB_PORT,
    user: config.DB_USER,
    password: config.DB_PASSWORD,
    database: config.DB_NAME,
    connectionLimit: config.DB_POOL_SIZE,
    waitForConnections: true,
    queueLimit: 200,
    timezone: 'Z', // DATETIME(3) <-> JS Date as UTC, so JSON comes out "...Z"
    decimalNumbers: true, // DECIMAL -> JS number (Dart's `as num?` expects this)
    typeCast: typeCast as never,
  });
  pool.on('connection', (conn) => {
    conn.query("SET time_zone='+00:00'");
  });
  return pool;
}

export default fp(async function dbPlugin(app: FastifyInstance) {
  const pool = createPool();
  app.decorate('db', pool);
  app.addHook('onClose', async () => {
    await pool.end();
  });
});
