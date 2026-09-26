import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { config } from '../config.js';

/** Local-disk storage adapter. `STORAGE_DRIVER=s3` is the documented upgrade
 * path (docs/backend-migration/PLAN.md §2.2) — swap this one file when needed;
 * nothing else references the filesystem directly. */
export async function saveFile(relativePath: string, buffer: Buffer): Promise<string> {
  const full = join(config.UPLOAD_DIR, relativePath);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, buffer);
  return publicUrl(relativePath);
}

export function publicUrl(relativePath: string): string {
  return `${config.PUBLIC_ASSET_BASE_URL.replace(/\/$/, '')}/${relativePath}`;
}
