import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { saveFile } from '../../lib/storage.js';
import { Errors } from '../../plugins/errors.js';

const ALLOWED_EXT = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif']);

function extOf(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return ALLOWED_EXT.has(ext) ? (ext === 'jpeg' ? 'jpg' : ext) : 'jpg';
}

/** Content-hash filenames — a repeat upload of the same bytes reuses the same
 * URL, and a *changed* image never collides with a stale CDN-cached copy of
 * the old one (unlike Supabase's fixed `avatars/<id>.<ext>` / `items/<id>.<ext>`
 * paths — docs/backend-migration/PLAN.md §4.2). */
async function handleUpload(app: FastifyInstance, req: FastifyRequest, folder: string) {
  const file = await req.file();
  if (!file) throw Errors.badRequest('No file uploaded.');
  const buffer = await file.toBuffer();
  if (buffer.length === 0) throw Errors.badRequest('Empty file.');
  const ext = extOf(file.filename ?? 'upload.jpg');
  const hash = createHash('sha256').update(buffer).digest('hex').slice(0, 16);
  const relativePath = `${folder}/${hash}.${ext}`;
  const url = await saveFile(relativePath, buffer);
  return { url };
}

export default async function uploadRoutes(app: FastifyInstance) {
  app.post('/uploads/avatar', { preHandler: app.authenticate }, async (req) => {
    return handleUpload(app, req, `avatars/${req.user.sub}`);
  });

  app.post(
    '/uploads/item-image',
    { preHandler: [app.authenticate, app.requirePerm('can_manage_items')] },
    async (req) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.query);
      return handleUpload(app, req, `items/${id}`);
    },
  );
}
