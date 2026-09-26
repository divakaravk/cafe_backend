import 'dotenv/config';
import { z } from 'zod';

// Fails fast and loud on a bad/missing env var, rather than limping along with
// `undefined` until something breaks three requests later.
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.string().default('info'),

  DB_HOST: z.string().default('127.0.0.1'),
  DB_PORT: z.coerce.number().int().positive().default(3306),
  DB_USER: z.string().default('root'),
  DB_PASSWORD: z.string().default(''),
  DB_NAME: z.string().default('cafe'),
  DB_POOL_SIZE: z.coerce.number().int().positive().default(20),

  JWT_ACCESS_SECRET: z.string().min(16, 'JWT_ACCESS_SECRET must be at least 16 characters'),
  ACCESS_TTL: z.string().default('30m'),
  REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(30),

  CORS_ORIGINS: z.string().default(''),
  RBAC_ENFORCE: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  IDEMPOTENCY_TTL_HOURS: z.coerce.number().int().positive().default(24),

  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  UPLOAD_DIR: z.string().default('./uploads'),
  PUBLIC_ASSET_BASE_URL: z.string().default('http://localhost:3000/uploads'),

  FIREBASE_PROJECT_ID: z.string().optional(),
  FIREBASE_CLIENT_EMAIL: z.string().optional(),
  FIREBASE_PRIVATE_KEY: z.string().optional(),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

export const config = {
  ...parsed.data,
  corsOrigins: parsed.data.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
  firebase:
    parsed.data.FIREBASE_PROJECT_ID && parsed.data.FIREBASE_CLIENT_EMAIL && parsed.data.FIREBASE_PRIVATE_KEY
      ? {
          projectId: parsed.data.FIREBASE_PROJECT_ID,
          clientEmail: parsed.data.FIREBASE_CLIENT_EMAIL,
          privateKey: parsed.data.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        }
      : null,
};

export type Config = typeof config;
