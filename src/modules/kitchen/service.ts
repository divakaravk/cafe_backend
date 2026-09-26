import type { FastifyInstance } from 'fastify';
import { Errors } from '../../plugins/errors.js';

type Row = Record<string, unknown>;

/** Port of `SupabaseService.getActiveKots`. Kept byte-for-byte including a
 * quirk worth flagging: the comment above the original Dart query says "show
 * pending/in_progress always; include done KOTs from today only", but the
 * actual filter applies `created_at >= todayStart` to every row regardless of
 * status — so a still-pending KOT opened just before local midnight would
 * also drop off. Replicated as-is (not "fixed") to match current behaviour;
 * worth a deliberate decision later, not a silent change here.
 *
 * Unlike Supabase's version, this also embeds `table_cover` — the app's own
 * `KotMaster.fromJson` already reads it, but `getActiveKots` never sent it,
 * so the cover number has always shown blank on the kitchen screen
 * (docs/backend-migration/PLAN.md §1.3 finding #12). Purely additive. */
export async function getActiveKots(app: FastifyInstance, companyId: string) {
  const now = new Date();
  const todayStartUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  const [kotRows] = await app.db.query(
    `SELECT * FROM kot_master WHERE company_id = ? AND status <> 'cancelled' AND created_at >= ? ORDER BY created_at`,
    [companyId, todayStartUtc],
  );
  const kots = kotRows as Row[];
  if (kots.length === 0) return [];

  const kotIds = kots.map((k) => k.id as string);
  const [kotItemRows] = await app.db.query(
    `SELECT * FROM kot_item WHERE kot_id IN (${kotIds.map(() => '?').join(',')})`,
    kotIds,
  );
  const kotItems = kotItemRows as Row[];

  const billItemIds = [...new Set(kotItems.map((ki) => ki.bill_item_id as string))];
  const biById = new Map<string, string | null>();
  if (billItemIds.length) {
    const [biRows] = await app.db.query(
      `SELECT id, item_name_snapshot FROM bill_item WHERE id IN (${billItemIds.map(() => '?').join(',')})`,
      billItemIds,
    );
    for (const r of biRows as { id: string; item_name_snapshot: string | null }[]) biById.set(r.id, r.item_name_snapshot);
  }

  const sessionIds = [...new Set(kots.map((k) => k.table_session_id as string | null).filter((x): x is string => !!x))];
  const sessionById = new Map<string, Row>();
  if (sessionIds.length) {
    const [sessionRows] = await app.db.query(
      `SELECT ts.id, tm.table_number
         FROM table_session ts LEFT JOIN table_master tm ON tm.id = ts.table_id
        WHERE ts.id IN (${sessionIds.map(() => '?').join(',')})`,
      sessionIds,
    );
    for (const r of sessionRows as { id: string; table_number: string | null }[]) {
      sessionById.set(r.id, { table_master: r.table_number != null ? { table_number: r.table_number } : null });
    }
  }

  const coverIds = [...new Set(kots.map((k) => k.cover_id as string | null).filter((x): x is string => !!x))];
  const coverById = new Map<string, Row>();
  if (coverIds.length) {
    const [coverRows] = await app.db.query(
      `SELECT id, cover_number, label FROM table_cover WHERE id IN (${coverIds.map(() => '?').join(',')})`,
      coverIds,
    );
    for (const r of coverRows as { id: string; cover_number: number; label: string | null }[]) {
      coverById.set(r.id, { cover_number: r.cover_number, label: r.label });
    }
  }

  const itemsByKot = new Map<string, Row[]>();
  for (const ki of kotItems) {
    const withBillItem = { ...ki, bill_item: { item_name_snapshot: biById.get(ki.bill_item_id as string) ?? null } };
    const list = itemsByKot.get(ki.kot_id as string) ?? [];
    list.push(withBillItem);
    itemsByKot.set(ki.kot_id as string, list);
  }

  return kots.map((k) => ({
    ...k,
    table_session: k.table_session_id ? sessionById.get(k.table_session_id as string) ?? null : null,
    table_cover: k.cover_id ? coverById.get(k.cover_id as string) ?? null : null,
    kot_item: itemsByKot.get(k.id as string) ?? [],
  }));
}

export async function updateKotStatus(app: FastifyInstance, kotId: string, status: string, companyId: string) {
  const [result] = await app.db.execute('UPDATE kot_master SET status = ? WHERE id = ? AND company_id = ?', [
    status,
    kotId,
    companyId,
  ]);
  if ((result as { affectedRows: number }).affectedRows === 0) throw Errors.notFound('KOT');
}

export async function updateKotItemStatus(app: FastifyInstance, kotItemId: string, status: string, companyId: string) {
  const [result] = await app.db.execute(
    `UPDATE kot_item ki JOIN kot_master km ON km.id = ki.kot_id
        SET ki.status = ?
      WHERE ki.id = ? AND km.company_id = ?`,
    [status, kotItemId, companyId],
  );
  if ((result as { affectedRows: number }).affectedRows === 0) throw Errors.notFound('KOT item');
}
