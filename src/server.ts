import { buildApp } from './app.js';
import { config } from './config.js';
import { purgeExpiredIdempotencyKeys } from './plugins/idempotency.js';

const app = await buildApp();

// Hourly purge of expired idempotency rows (docs/backend-migration/PLAN.md §3.2 —
// `idempotency_key`, TTL configurable via IDEMPOTENCY_TTL_HOURS).
const purgeTimer = setInterval(() => {
  purgeExpiredIdempotencyKeys(app, config.IDEMPOTENCY_TTL_HOURS).catch((err) => app.log.error({ err }, 'idempotency purge failed'));
}, 60 * 60 * 1000);
purgeTimer.unref();

async function shutdown(signal: string) {
  app.log.info({ signal }, 'shutting down');
  clearInterval(purgeTimer);
  await app.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
