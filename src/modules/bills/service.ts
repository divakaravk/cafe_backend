import type { FastifyInstance } from 'fastify';
import { newId } from '../../lib/ids.js';
import { withTransaction } from '../../lib/tx.js';
import { round2, splitGst } from '../../lib/money.js';
import { allocateBillNumber } from '../../lib/numbering.js';
import { Errors } from '../../plugins/errors.js';

type Row = Record<string, unknown>;

interface BillItemInput {
  item_id?: string | null;
  variant_id?: string | null;
  item_name?: string | null;
  rate: number;
  qty: number;
  gst_rate?: number | null;
  is_taxable?: boolean | null;
  hsn_code?: string | null;
  discount_item?: number | null;
  notes?: string | null;
}

/** Direct-billing path (Quick Bill / Classic / Modern POS "Pay Now") — an
 * exact port of `SupabaseService.createBill`, **including** the fact that it
 * trusts the caller's subtotal/discount/total rather than recomputing them.
 * That's deliberate parity, not an oversight: this path and `saveOrderWithKot`
 * already disagree on tax handling in production (58/182 live bills don't
 * reconcile — docs/backend-migration/PLAN.md §1.3 finding #5), and unifying
 * them is an explicit Phase 8 decision, not something to silently change here. */
export async function createBill(
  app: FastifyInstance,
  params: {
    companyId: string;
    billedBy: string;
    tableSessionId?: string | null;
    subtotal: number;
    discountAmount: number;
    discountType?: string | null;
    totalAmount: number;
    paymentMode: string;
    billType: string;
    billItems: BillItemInput[];
  },
) {
  return withTransaction(app.db, async (conn) => {
    const [meta] = await conn.query('SELECT company_code, timezone FROM company_master WHERE id = ?', [
      params.companyId,
    ]);
    const company = (meta as { company_code: string; timezone: string }[])[0];
    if (!company) throw Errors.notFound('Company');

    if (params.tableSessionId) {
      const [sessionRows] = await conn.query('SELECT company_id FROM table_session WHERE id = ?', [params.tableSessionId]);
      const sessionCompany = (sessionRows as { company_id: string }[])[0]?.company_id;
      if (sessionCompany === undefined) throw Errors.notFound('Table session');
      if (sessionCompany !== params.companyId) throw Errors.forbidden();
    }

    const billNumber = await allocateBillNumber(conn, params.companyId, company.company_code, company.timezone);
    const now = new Date();

    let totalCgst = 0;
    let totalSgst = 0;
    const itemsToInsert = params.billItems.map((bi) => {
      const { cgst, sgst, gross } = splitGst(bi.qty, bi.rate, bi.gst_rate ?? 0, bi.is_taxable ?? true);
      totalCgst = round2(totalCgst + cgst);
      totalSgst = round2(totalSgst + sgst);
      return {
        id: newId(),
        item_id: bi.item_id ?? null,
        variant_id: bi.variant_id ?? null,
        item_name_snapshot: bi.item_name ?? '',
        rate_snapshot: bi.rate,
        qty: bi.qty,
        gross_amount: gross,
        discount_amount: bi.discount_item ?? 0,
        hsn_code_snapshot: bi.hsn_code ?? null,
        gst_rate_snapshot: bi.gst_rate ?? 0,
        cgst_amount: cgst,
        sgst_amount: sgst,
        igst_amount: 0,
        net_amount: round2(gross + cgst + sgst),
        notes: bi.notes ?? null,
      };
    });

    const billId = newId();
    await conn.execute(
      `INSERT INTO bill_master
         (id, company_id, billed_by, table_session_id, bill_number, bill_type, subtotal, discount_amount,
          discount_type, taxable_amount, cgst_amount, sgst_amount, igst_amount, total_amount, payment_mode,
          status, bill_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 'paid', ?)`,
      [
        billId, params.companyId, params.billedBy, params.tableSessionId ?? null, billNumber, params.billType,
        params.subtotal, params.discountAmount, params.discountType ?? null, params.subtotal, totalCgst, totalSgst,
        params.totalAmount, params.paymentMode.toLowerCase(), now,
      ],
    );
    for (const item of itemsToInsert) {
      await conn.execute(
        `INSERT INTO bill_item
           (id, bill_id, item_id, variant_id, item_name_snapshot, rate_snapshot, qty, gross_amount,
            discount_amount, hsn_code_snapshot, gst_rate_snapshot, cgst_amount, sgst_amount, igst_amount, net_amount, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          item.id, billId, item.item_id, item.variant_id, item.item_name_snapshot, item.rate_snapshot, item.qty,
          item.gross_amount, item.discount_amount, item.hsn_code_snapshot, item.gst_rate_snapshot, item.cgst_amount,
          item.sgst_amount, item.igst_amount, item.net_amount, item.notes,
        ],
      );
    }
    if (params.tableSessionId) {
      await conn.execute("UPDATE table_session SET status = 'billed', closed_at = ? WHERE id = ?", [
        now,
        params.tableSessionId,
      ]);
    }

    const [rows] = await conn.query('SELECT * FROM bill_master WHERE id = ?', [billId]);
    return (rows as Row[])[0];
  });
}

/** Same 3-query assembly pattern as `items/service.ts` — one query per embed
 * level, joined in JS, never a row-exploding join. Capped at 5,000 rows per
 * call as a safety net (unlike Supabase's silent 1,000-row cap — see
 * docs/backend-migration/PLAN.md §1.3 finding #14 — this at least fails loud:
 * callers needing more must page, which the web-view work adds properly). */
export async function getBills(
  app: FastifyInstance,
  companyId: string,
  opts: { startDate?: Date; endDate?: Date; limit?: number },
) {
  const conditions = ['company_id = ?'];
  const values: unknown[] = [companyId];
  if (opts.startDate) {
    conditions.push('bill_date >= ?');
    values.push(opts.startDate);
  }
  if (opts.endDate) {
    conditions.push('bill_date <= ?');
    values.push(opts.endDate);
  }
  const limit = Math.min(opts.limit ?? 5000, 5000);
  const [billRows] = await app.db.query(
    `SELECT * FROM bill_master WHERE ${conditions.join(' AND ')} ORDER BY bill_date DESC LIMIT ${limit}`,
    values,
  );
  const bills = billRows as Row[];
  if (bills.length === 0) return [];

  const billIds = bills.map((b) => b.id as string);
  const [itemRows] = await app.db.query(
    `SELECT * FROM bill_item WHERE bill_id IN (${billIds.map(() => '?').join(',')})`,
    billIds,
  );
  const itemsByBill = new Map<string, Row[]>();
  for (const item of itemRows as (Row & { bill_id: string })[]) {
    const list = itemsByBill.get(item.bill_id) ?? [];
    list.push(item);
    itemsByBill.set(item.bill_id, list);
  }

  const sessionIds = [...new Set(bills.map((b) => b.table_session_id as string | null).filter((x): x is string => !!x))];
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

  const coverIds = [...new Set(bills.map((b) => b.cover_id as string | null).filter((x): x is string => !!x))];
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

  return bills.map((b) => ({
    ...b,
    bill_item: itemsByBill.get(b.id as string) ?? [],
    table_session: b.table_session_id ? sessionById.get(b.table_session_id as string) ?? null : null,
    table_cover: b.cover_id ? coverById.get(b.cover_id as string) ?? null : null,
  }));
}

export async function cancelBill(
  app: FastifyInstance,
  params: { billId: string; companyId: string; reason?: string | null; userId: string },
) {
  const data: Row = { status: 'cancelled' };
  if (params.reason) data.notes = `Cancelled: ${params.reason}`;
  const sets = Object.keys(data).map((k) => `${k} = ?`).join(', ');
  const [result] = await app.db.execute(
    `UPDATE bill_master SET ${sets} WHERE id = ? AND company_id = ?`,
    [...Object.values(data), params.billId, params.companyId] as any[],
  );
  if ((result as { affectedRows: number }).affectedRows === 0) throw Errors.notFound('Bill');
  await app.db.execute(
    'INSERT INTO audit_log (user_id, action, entity, entity_id, meta) VALUES (?, ?, ?, ?, CAST(? AS JSON))',
    [params.userId, 'bill.cancel', 'bill_master', params.billId, JSON.stringify({ reason: params.reason ?? null })],
  );
}

export async function updateBill(
  app: FastifyInstance,
  params: {
    billId: string;
    companyId: string;
    userId: string;
    items: { id: string; qty: number; rate: number; gst_rate?: number }[];
    removedItemIds: string[];
    discountAmount: number;
  },
) {
  return withTransaction(app.db, async (conn) => {
    const [billRows] = await conn.query('SELECT company_id FROM bill_master WHERE id = ? FOR UPDATE', [params.billId]);
    const billCompany = (billRows as { company_id: string }[])[0]?.company_id;
    if (billCompany === undefined) throw Errors.notFound('Bill');
    if (billCompany !== params.companyId) throw Errors.forbidden();

    // Every line-item id touched (edited or removed) must actually belong to
    // THIS bill — otherwise a caller could pass an id from a different bill
    // (even a different company's) and edit or delete it here.
    const touchedIds = [...params.items.map((it) => it.id), ...params.removedItemIds];
    if (touchedIds.length) {
      const [ownedRows] = await conn.query(
        `SELECT id FROM bill_item WHERE bill_id = ? AND id IN (${touchedIds.map(() => '?').join(',')})`,
        [params.billId, ...touchedIds],
      );
      const ownedIds = new Set((ownedRows as { id: string }[]).map((r) => r.id));
      if (touchedIds.some((id) => !ownedIds.has(id))) {
        throw Errors.badRequest('One or more items do not belong to this bill.');
      }
    }

    if (params.removedItemIds.length) {
      await conn.execute(
        `DELETE FROM bill_item WHERE id IN (${params.removedItemIds.map(() => '?').join(',')})`,
        params.removedItemIds,
      );
    }

    let subtotal = 0;
    let totalCgst = 0;
    let totalSgst = 0;
    for (const it of params.items) {
      const line = round2(it.qty * it.rate);
      const tax = round2((line * (it.gst_rate ?? 0)) / 100);
      const cgst = round2(tax / 2);
      const sgst = round2(tax / 2);
      subtotal = round2(subtotal + line);
      totalCgst = round2(totalCgst + cgst);
      totalSgst = round2(totalSgst + sgst);
      await conn.execute(
        'UPDATE bill_item SET qty = ?, gross_amount = ?, cgst_amount = ?, sgst_amount = ?, net_amount = ? WHERE id = ?',
        [it.qty, line, cgst, sgst, round2(line + tax), it.id],
      );
    }

    const total = Math.max(0, round2(subtotal + totalCgst + totalSgst - params.discountAmount));
    await conn.execute(
      'UPDATE bill_master SET subtotal = ?, taxable_amount = ?, cgst_amount = ?, sgst_amount = ?, discount_amount = ?, total_amount = ? WHERE id = ?',
      [subtotal, subtotal, totalCgst, totalSgst, params.discountAmount, total, params.billId],
    );
    await conn.execute(
      'INSERT INTO audit_log (user_id, action, entity, entity_id, meta) VALUES (?, ?, ?, ?, CAST(? AS JSON))',
      [params.userId, 'bill.edit', 'bill_master', params.billId, JSON.stringify({ removed: params.removedItemIds.length, edited: params.items.length })],
    );
  });
}
