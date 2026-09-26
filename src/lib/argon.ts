import { hash, verify } from '@node-rs/argon2';

// OWASP-recommended argon2id parameters for an interactive login (2025 guidance):
// 19 MiB memory, 2 iterations, 1 degree of parallelism.
const OPTS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(plain: string): Promise<string> {
  return hash(plain, OPTS);
}

export function verifyPassword(plain: string, hashed: string): Promise<boolean> {
  return verify(hashed, plain).catch(() => false);
}
