// Throwaway MySQL 8.4 instance for local dev/testing — same tool used to
// verify docs/backend-migration/schema.mysql.sql. Not part of the build; run
// directly with `node scripts/dev-mysql.mjs`. Prints the port then blocks.
import { createDB } from 'mysql-memory-server';
import { writeFileSync } from 'node:fs';

console.log('starting embedded MySQL 8.4 (downloads binaries on first run)...');
const db = await createDB({
  version: '8.4.x',
  dbName: 'cafe',
  username: 'root',
  logLevel: 'ERROR',
  downloadBinaryOnce: true,
  ignoreUnsupportedSystemVersion: true,
});
writeFileSync('dev-mysql.json', JSON.stringify({ port: db.port }));
console.log('READY port=' + db.port);
setInterval(() => {}, 1 << 30);
