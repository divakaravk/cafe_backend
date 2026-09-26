import type { FastifyInstance } from 'fastify';
import { newId } from '../../lib/ids.js';
import { withTransaction } from '../../lib/tx.js';
import { Errors } from '../../plugins/errors.js';
import { assertOwnedByCompany, assertNoHijack } from '../../lib/tenant.js';

type Row = Record<string, unknown>;

/** Fetches company_hsn rows for a set of ids and returns a lookup map — the
 * single-object embed PostgREST calls `company_hsn(*)` on a many-to-one FK. */
async function hsnLookup(app: FastifyInstance, ids: (string | null)[]): Promise<Map<string, Row>> {
  const distinct = [...new Set(ids.filter((x): x is string => !!x))];
  if (distinct.length === 0) return new Map();
  const [rows] = await app.db.query(`SELECT * FROM company_hsn WHERE id IN (${distinct.map(() => '?').join(',')})`, distinct);
  return new Map((rows as Row[]).map((r) => [r.id as string, r]));
}

/** Assembles item_master rows with their nested `company_hsn` (object) and
 * `item_variant` (array, each with its own nested `company_hsn`) — the same
 * shape `'*, company_hsn(*), item_variant!item_variant_item_id_fkey(*, company_hsn(*))'`
 * produces today. 3 queries total, never one row-exploding join (see
 * docs/backend-migration/PLAN.md §4.2). */
async function assembleGroups(app: FastifyInstance, companyId: string, orderBy: 'display_order' | 'item_name') {
  const [groupRows] = await app.db.query(
    `SELECT * FROM item_master WHERE company_id = ? ORDER BY ${orderBy}`,
    [companyId],
  );
  const groups = groupRows as Row[];
  if (groups.length === 0) return [];

  const groupIds = groups.map((g) => g.id as string);
  const [variantRows] = await app.db.query(
    `SELECT * FROM item_variant WHERE item_id IN (${groupIds.map(() => '?').join(',')}) ORDER BY display_order, variant_name`,
    groupIds,
  );
  const variants = variantRows as Row[];

  const hsnIds = [...groups.map((g) => g.hsn_id as string | null), ...variants.map((v) => v.hsn_id as string | null)];
  const hsnById = await hsnLookup(app, hsnIds);

  const variantsByGroup = new Map<string, Row[]>();
  for (const v of variants) {
    const withHsn = { ...v, company_hsn: hsnById.get(v.hsn_id as string) ?? null };
    const list = variantsByGroup.get(v.item_id as string) ?? [];
    list.push(withHsn);
    variantsByGroup.set(v.item_id as string, list);
  }

  return groups.map((g) => ({
    ...g,
    company_hsn: hsnById.get(g.hsn_id as string) ?? null,
    item_variant: variantsByGroup.get(g.id as string) ?? [],
  }));
}

export const getItemGroups = (app: FastifyInstance, companyId: string) => assembleGroups(app, companyId, 'display_order');
export const getAllItems = (app: FastifyInstance, companyId: string) => assembleGroups(app, companyId, 'item_name');

export async function getVariantsByGroup(app: FastifyInstance, itemId: string, onlySellable: boolean) {
  const filter = onlySellable ? 'AND is_active = 1 AND is_available = 1' : '';
  const [rows] = await app.db.query(
    `SELECT * FROM item_variant WHERE item_id = ? ${filter} ORDER BY display_order, variant_name`,
    [itemId],
  );
  const variants = rows as Row[];
  const hsnById = await hsnLookup(app, variants.map((v) => v.hsn_id as string | null));
  return variants.map((v) => ({ ...v, company_hsn: hsnById.get(v.hsn_id as string) ?? null }));
}

export async function deleteItemMaster(app: FastifyInstance, id: string, companyId: string) {
  await assertOwnedByCompany(app, 'SELECT company_id FROM item_master WHERE id = ?', id, companyId, 'Item group');
  // default_variant_id has no FK (it would be circular — see the schema
  // comment). Clear it first so the variant cascade-delete below is clean.
  await withTransaction(app.db, async (conn) => {
    await conn.execute('UPDATE item_master SET default_variant_id = NULL WHERE id = ?', [id]);
    await conn.execute('DELETE FROM item_master WHERE id = ?', [id]);
  });
}

const ITEM_MASTER_COLUMNS = [
  'id', 'company_id', 'hsn_id', 'item_code', 'item_name', 'description', 'base_rate',
  'has_variants', 'is_taxable', 'is_active', 'image_url', 'display_order',
  'section_label', 'color_tag', 'food_type', 'short_name', 'local_name', 'search_keywords',
  'badge', 'is_featured', 'is_recommended', 'preparation_time', 'default_variant_id',
  'is_online_visible', 'is_pos_visible', 'is_qr_visible', 'is_self_order_visible',
  'stock_enabled', 'unlimited_stock', 'sold_out', 'packing_charge', 'loyalty_enabled',
  'discount_allowed', 'updated_by',
] as const;

/** Upserts an item group row. Only whitelisted columns are ever written —
 * lifted from the direct `SupabaseService.client` call this replaces
 * (item_master_screen.dart's `_save`); the whitelist is new (the old call
 * forwarded the whole client-built map verbatim). */
export async function saveItemGroup(app: FastifyInstance, companyId: string, data: Row) {
  const id = (data.id as string) ?? newId();
  await assertNoHijack(app, 'SELECT company_id FROM item_master WHERE id = ?', id, companyId, 'item group');
  const row: Row = { ...data, id, company_id: companyId };
  const cols = ITEM_MASTER_COLUMNS.filter((c) => row[c] !== undefined);
  const values = cols.map((c) => row[c]);
  await app.db.execute(
    `INSERT INTO item_master (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})
     ON DUPLICATE KEY UPDATE ${cols.filter((c) => c !== 'id').map((c) => `${c} = VALUES(${c})`).join(', ')}`,
    values as any[],
  );
  return { id };
}

const ITEM_VARIANT_COLUMNS = [
  'id', 'item_id', 'variant_name', 'rate_override', 'is_active', 'image_url', 'hsn_id',
  'inclusive_rate', 'is_rate_inclusive', 'description', 'display_order', 'is_available',
  'base_rate', 'sku', 'barcode', 'short_name', 'local_name', 'print_name', 'kitchen_name',
  'calories', 'portion_size', 'unit', 'preparation_time', 'is_default', 'is_popular',
  'is_new', 'is_recommended', 'badge', 'online_visible', 'pos_visible', 'qr_visible',
  'self_order_visible', 'dine_in_available', 'takeaway_available', 'delivery_available',
  'stock_enabled', 'unlimited_stock', 'current_stock', 'reorder_level', 'packing_charge',
  'service_charge', 'search_keywords', 'display_color', 'sort_priority', 'updated_by', 'food_type',
] as const;

export async function upsertVariant(app: FastifyInstance, data: Row, companyId: string) {
  const id = (data.id as string) ?? newId();
  const itemId = data.item_id as string | undefined;
  // A variant is owned via its parent group, not a column of its own: verify
  // both the TARGET group (item_id in the payload) and, on an update, the
  // variant's CURRENT group both belong to the caller — otherwise either
  // direction could be used to reattach/hijack a row across companies.
  if (itemId) {
    await assertOwnedByCompany(app, 'SELECT company_id FROM item_master WHERE id = ?', itemId, companyId, 'Item group');
  }
  await assertNoHijack(
    app,
    'SELECT im.company_id AS company_id FROM item_variant iv JOIN item_master im ON im.id = iv.item_id WHERE iv.id = ?',
    id,
    companyId,
    'item variant',
  );
  const row: Row = { ...data, id };
  const cols = ITEM_VARIANT_COLUMNS.filter((c) => row[c] !== undefined);
  const values = cols.map((c) => row[c]);
  await app.db.execute(
    `INSERT INTO item_variant (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})
     ON DUPLICATE KEY UPDATE ${cols.filter((c) => c !== 'id').map((c) => `${c} = VALUES(${c})`).join(', ')}`,
    values as any[],
  );
  return { id };
}

export async function deleteVariant(app: FastifyInstance, id: string, companyId: string) {
  await assertOwnedByCompany(
    app,
    'SELECT im.company_id AS company_id FROM item_variant iv JOIN item_master im ON im.id = iv.item_id WHERE iv.id = ?',
    id,
    companyId,
    'Item variant',
  );
  await app.db.execute('DELETE FROM item_variant WHERE id = ?', [id]);
}

/** Marks [variantId] as the single default for its group and syncs the
 * group's `default_variant_id` pointer — same 3-step "clear siblings, set
 * flag, sync pointer" the Dart client did, just atomic now. */
export async function setDefaultVariant(app: FastifyInstance, itemId: string, variantId: string, companyId: string) {
  await assertOwnedByCompany(app, 'SELECT company_id FROM item_master WHERE id = ?', itemId, companyId, 'Item group');
  const [variantRows] = await app.db.query('SELECT item_id FROM item_variant WHERE id = ?', [variantId]);
  const variantItemId = (variantRows as { item_id: string }[])[0]?.item_id;
  if (variantItemId !== itemId) throw Errors.badRequest('That variant does not belong to this item group.');

  await withTransaction(app.db, async (conn) => {
    await conn.execute('UPDATE item_variant SET is_default = 0 WHERE item_id = ?', [itemId]);
    await conn.execute('UPDATE item_variant SET is_default = 1 WHERE id = ?', [variantId]);
    await conn.execute('UPDATE item_master SET default_variant_id = ? WHERE id = ?', [variantId, itemId]);
  });
}

export async function setGroupDefaultVariantPointer(
  app: FastifyInstance,
  itemId: string,
  variantId: string,
  companyId: string,
) {
  await assertOwnedByCompany(app, 'SELECT company_id FROM item_master WHERE id = ?', itemId, companyId, 'Item group');
  const [result] = await app.db.execute('UPDATE item_master SET default_variant_id = ? WHERE id = ?', [
    variantId,
    itemId,
  ]);
  if ((result as { affectedRows: number }).affectedRows === 0) throw Errors.notFound('Item group');
}
