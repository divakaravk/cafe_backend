import type { FastifyInstance } from 'fastify';
import { newId } from '../../lib/ids.js';
import { Errors } from '../../plugins/errors.js';

type Row = Record<string, unknown>;

/** One query replacing the old client's 5 round-trips + Dart-side aggregation
 * (docs/backend-migration/PLAN.md §3.5, verified under concurrency in
 * docs/backend-migration/verify/behaviour-check.js). Returns raw `opened_at`
 * rather than a pre-anchored `occupied_since` — the Flutter `RestBackend`
 * adapter re-anchors it against `/v1/time` itself, exactly as the old
 * `SupabaseService.getTables` did with `getServerNow()`. */
export async function getTables(app: FastifyInstance, companyId: string) {
  const [rows] = await app.db.query(
    `SELECT t.id, t.company_id, t.table_number, t.section, t.seating_capacity, t.qr_code, t.is_active,
            s.id AS active_session_id, s.opened_at,
            (s.id IS NOT NULL) AS is_occupied,
            COALESCE(b.total, 0) AS active_order_total,
            COALESCE(c.cnt, 0)   AS active_cover_count
       FROM table_master t
       LEFT JOIN table_session s ON s.open_table_key = t.id
       LEFT JOIN LATERAL (
              SELECT SUM(total_amount) AS total FROM bill_master
               WHERE table_session_id = s.id AND status = 'open') b ON TRUE
       LEFT JOIN LATERAL (
              SELECT COUNT(*) AS cnt FROM table_cover
               WHERE table_session_id = s.id AND status = 'active') c ON TRUE
      WHERE t.company_id = ?
      ORDER BY t.table_number`,
    [companyId],
  );
  return (rows as Row[]).map((r) => ({
    ...r,
    is_occupied: r.is_occupied === 1 || r.is_occupied === true,
    opened_at: r.opened_at ? new Date(r.opened_at as string).toISOString() : null,
  }));
}

export async function createTable(
  app: FastifyInstance,
  params: { companyId: string; tableNumber: string; section?: string | null; seatingCapacity: number; isActive: boolean },
) {
  const id = newId();
  const section = params.section?.trim() || 'Main';
  await app.db.execute(
    'INSERT INTO table_master (id, company_id, table_number, section, seating_capacity, is_active) VALUES (?, ?, ?, ?, ?, ?)',
    [id, params.companyId, params.tableNumber, section, params.seatingCapacity, params.isActive],
  );
  return { id };
}

export async function updateTable(
  app: FastifyInstance,
  params: { id: string; companyId: string; tableNumber: string; section?: string | null; seatingCapacity: number; isActive: boolean },
) {
  const section = params.section?.trim() || 'Main';
  // Scoped directly in the WHERE clause (table_master has company_id as a
  // plain column) rather than a separate ownership pre-check: cheaper, and it
  // doesn't tell a caller whether a foreign id exists at all vs. belongs to
  // someone else — both come back as the same 404.
  const [result] = await app.db.execute(
    'UPDATE table_master SET table_number = ?, section = ?, seating_capacity = ?, is_active = ? WHERE id = ? AND company_id = ?',
    [params.tableNumber, section, params.seatingCapacity, params.isActive, params.id, params.companyId],
  );
  if ((result as { affectedRows: number }).affectedRows === 0) throw Errors.notFound('Table');
}

export async function isTableOccupied(app: FastifyInstance, tableId: string, companyId: string): Promise<boolean> {
  const [rows] = await app.db.query(
    `SELECT s.id FROM table_session s JOIN table_master t ON t.id = s.table_id
      WHERE s.table_id = ? AND s.status = 'open' AND t.company_id = ? LIMIT 1`,
    [tableId, companyId],
  );
  return (rows as Row[]).length > 0;
}
