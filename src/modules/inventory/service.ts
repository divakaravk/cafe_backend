import type { FastifyInstance } from 'fastify';
import { newId } from '../../lib/ids.js';
import { Errors } from '../../plugins/errors.js';
import { assertOwnedByCompany, assertNoHijack } from '../../lib/tenant.js';

type Row = Record<string, unknown>;

export async function getRawMaterials(app: FastifyInstance, companyId: string) {
  const [rows] = await app.db.query(
    'SELECT * FROM raw_material WHERE company_id = ? AND is_active = 1 ORDER BY name',
    [companyId],
  );
  return rows;
}

export async function upsertRawMaterial(app: FastifyInstance, companyId: string, data: Row) {
  const id = (data.id as string) ?? newId();
  await assertNoHijack(app, 'SELECT company_id FROM raw_material WHERE id = ?', id, companyId, 'raw material');
  const cols = ['id', 'company_id', 'name', 'unit', 'opening_stock', 'reorder_level', 'cost_per_unit', 'is_active'] as const;
  const row: Row = { ...data, id, company_id: companyId };
  const present = cols.filter((c) => row[c] !== undefined);
  await app.db.execute(
    `INSERT INTO raw_material (${present.join(', ')}) VALUES (${present.map(() => '?').join(', ')})
     ON DUPLICATE KEY UPDATE ${present.filter((c) => c !== 'id').map((c) => `${c} = VALUES(${c})`).join(', ')}`,
    present.map((c) => row[c]) as any[], // dynamic column list -> dynamic param types
  );
  return { id };
}

export async function deleteRawMaterial(app: FastifyInstance, id: string, companyId: string) {
  await assertOwnedByCompany(app, 'SELECT company_id FROM raw_material WHERE id = ?', id, companyId, 'Raw material');
  await app.db.execute('UPDATE raw_material SET is_active = 0 WHERE id = ?', [id]);
}

export async function getRecipeForVariant(app: FastifyInstance, itemVariantId: string, companyId: string) {
  await assertOwnedByCompany(
    app,
    'SELECT im.company_id AS company_id FROM item_variant iv JOIN item_master im ON im.id = iv.item_id WHERE iv.id = ?',
    itemVariantId,
    companyId,
    'Item variant',
  );
  const [rows] = await app.db.query('SELECT * FROM variant_recipe WHERE item_variant_id = ?', [itemVariantId]);
  return rows;
}

export async function upsertRecipeLine(app: FastifyInstance, data: Row, companyId: string) {
  const id = (data.id as string) ?? newId();
  const variantId = data.item_variant_id as string | undefined;
  const materialId = data.raw_material_id as string | undefined;
  // A recipe line has no company_id of its own — it's owned via both the
  // variant (-> item group) and the raw material it consumes. Verify both
  // belong to the caller before linking them.
  if (variantId) {
    await assertOwnedByCompany(
      app,
      'SELECT im.company_id AS company_id FROM item_variant iv JOIN item_master im ON im.id = iv.item_id WHERE iv.id = ?',
      variantId,
      companyId,
      'Item variant',
    );
  }
  if (materialId) {
    await assertOwnedByCompany(app, 'SELECT company_id FROM raw_material WHERE id = ?', materialId, companyId, 'Raw material');
  }
  await assertNoHijack(
    app,
    'SELECT rm.company_id AS company_id FROM variant_recipe vr JOIN raw_material rm ON rm.id = vr.raw_material_id WHERE vr.id = ?',
    id,
    companyId,
    'recipe line',
  );
  const cols = ['id', 'item_variant_id', 'raw_material_id', 'qty_per_unit'] as const;
  const row: Row = { ...data, id };
  const present = cols.filter((c) => row[c] !== undefined);
  await app.db.execute(
    `INSERT INTO variant_recipe (${present.join(', ')}) VALUES (${present.map(() => '?').join(', ')})
     ON DUPLICATE KEY UPDATE ${present.filter((c) => c !== 'id').map((c) => `${c} = VALUES(${c})`).join(', ')}`,
    present.map((c) => row[c]) as any[],
  );
  return { id };
}

export async function deleteRecipeLine(app: FastifyInstance, id: string, companyId: string) {
  await assertOwnedByCompany(
    app,
    'SELECT rm.company_id AS company_id FROM variant_recipe vr JOIN raw_material rm ON rm.id = vr.raw_material_id WHERE vr.id = ?',
    id,
    companyId,
    'Recipe line',
  );
  await app.db.execute('DELETE FROM variant_recipe WHERE id = ?', [id]);
}

export async function countRecipeLinesUsingMaterial(app: FastifyInstance, rawMaterialId: string, companyId: string): Promise<number> {
  await assertOwnedByCompany(app, 'SELECT company_id FROM raw_material WHERE id = ?', rawMaterialId, companyId, 'Raw material');
  const [rows] = await app.db.query('SELECT COUNT(*) AS n FROM variant_recipe WHERE raw_material_id = ?', [
    rawMaterialId,
  ]);
  return (rows as { n: number }[])[0]?.n ?? 0;
}

/** `is_low_stock` from `v_current_stock` is a computed BIGINT (0/1), not a
 * TINYINT(1) column, so the driver's `typeCast` can't coerce it — done here
 * instead (see docs/backend-migration/PLAN.md §3.4). */
export async function getCurrentStock(app: FastifyInstance, companyId: string) {
  const [rows] = await app.db.query('SELECT * FROM v_current_stock WHERE company_id = ? ORDER BY name', [companyId]);
  return (rows as Row[]).map((r) => ({ ...r, is_low_stock: r.is_low_stock === 1 || r.is_low_stock === true }));
}

/** Real `GROUP BY` in SQL for every case (with or without a date range) — the
 * Dart client used to aggregate the unfiltered view directly but do the
 * date-filtered case by hand in memory; one query now covers both. */
export async function getStaffConsumption(
  app: FastifyInstance,
  companyId: string,
  opts: { from?: Date; to?: Date; staffId?: string },
) {
  const conditions = ['sl.company_id = ?', "sl.movement_type = 'consumed'"];
  const values: unknown[] = [companyId];
  if (opts.from) {
    conditions.push('sl.created_at >= ?');
    values.push(opts.from);
  }
  if (opts.to) {
    conditions.push('sl.created_at <= ?');
    values.push(opts.to);
  }
  if (opts.staffId) {
    conditions.push('sl.staff_id = ?');
    values.push(opts.staffId);
  }
  const [rows] = await app.db.query(
    `SELECT sl.staff_id, up.user_name AS staff_name, rm.id AS raw_material_id, rm.name AS raw_material_name,
            rm.unit, rm.company_id, SUM(-sl.qty) AS total_consumed
       FROM stock_ledger sl
       JOIN raw_material rm ON rm.id = sl.raw_material_id
       LEFT JOIN user_profiles up ON up.id = sl.staff_id
      WHERE ${conditions.join(' AND ')}
      GROUP BY sl.staff_id, up.user_name, rm.id, rm.name, rm.unit, rm.company_id`,
    values,
  );
  return rows;
}

export async function submitStockAdjustment(
  app: FastifyInstance,
  params: {
    companyId: string;
    rawMaterialId: string;
    qty: number;
    movementType: string;
    note?: string | null;
    shiftLabel?: string | null;
    staffId?: string | null;
  },
) {
  const [material] = await app.db.query('SELECT id FROM raw_material WHERE id = ? AND company_id = ?', [
    params.rawMaterialId,
    params.companyId,
  ]);
  if ((material as Row[]).length === 0) throw Errors.notFound('Raw material');

  await app.db.execute(
    'INSERT INTO stock_ledger (id, company_id, raw_material_id, movement_type, qty, note, shift_label, staff_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [newId(), params.companyId, params.rawMaterialId, params.movementType, params.qty, params.note ?? null, params.shiftLabel ?? null, params.staffId ?? null],
  );
}
