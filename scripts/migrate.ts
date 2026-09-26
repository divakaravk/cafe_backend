// Lightweight migration runner — no separate migration-framework dependency.
// Applies every db/migrations/*.sql file (in filename order) that isn't yet
// recorded in `schema_migrations`, each inside its own multi-statement
// connection so a partial failure doesn't half-apply a file.
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import mysql from 'mysql2/promise';
import 'dotenv/config';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', 'db', 'migrations');

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER ?? 'root',
    password: process.env.DB_PASSWORD ?? '',
    multipleStatements: true,
  });

  const dbName = process.env.DB_NAME ?? 'cafe';
  await conn.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4`);
  await conn.changeUser({ database: dbName });

  await conn.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename VARCHAR(255) PRIMARY KEY,
      applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ) ENGINE=InnoDB
  `);

  const [appliedRows] = await conn.query('SELECT filename FROM schema_migrations');
  const applied = new Set((appliedRows as { filename: string }[]).map((r) => r.filename));

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  let ranAny = false;
  for (const file of files) {
    if (applied.has(file)) {
      console.log(`- ${file} (already applied)`);
      continue;
    }
    console.log(`> applying ${file} ...`);
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    await conn.query(sql);
    await conn.execute('INSERT INTO schema_migrations (filename) VALUES (?)', [file]);
    console.log(`  done.`);
    ranAny = true;
  }
  if (!ranAny) console.log('Nothing to apply — schema is up to date.');

  await conn.end();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
