import type { FastifyInstance } from 'fastify';
import type { PoolConnection } from 'mysql2/promise';
import { z } from 'zod';
import { newId } from '../../lib/ids.js';
import { withTransaction } from '../../lib/tx.js';
import { splitGst, round2 } from '../../lib/money.js';
import { allocateBillNumber, allocateKotNumber } from '../../lib/numbering.js';
import { Errors } from '../../plugins/errors.js';
import type { CartItemInput } from './schemas.js';

type Row = Record<string, unknown>;

export async function createOrder(
  app: FastifyInstance,
  params: { companyId: string; tableId?: string | null; openedBy: string },
) {
  const id = newId();
  await app.db.execute(
    'INSERT INTO table_session (id, company_id, table_id, opened_by, status) VALUES (?, ?, ?, ?, ?)',
    [id, params.companyId, params.tableId ?? null, params.openedBy, 'open'],
  );
  const [rows] = await app.db.query('SELECT * FROM table_session WHERE id = ?', [id]);
  return (rows as Row[])[0];
}

/** Race-free get-or-create of the OPEN session for a table — relies on
 * `uq_session_one_open_per_table` (verified under 30-way concurrency in
 * docs/backend-migration/verify/behaviour-check.js: all callers land on the
 * same session id, exactly one row is created). */
async function getOrCreateOpenSession(
  conn: PoolConnection,
  params: { companyId: string; tableId: string; openedBy: string },
): Promise<string> {
  // Without this, a session could be created with company_id = caller's own
  // but table_id pointing at another company's physical table — every
  // company-scoped read that joins through it downstream would then be
  // inconsistent (or worse, leak/mutate the wrong tenant's table state).
  const [tableRows] = await conn.query('SELECT company_id FROM table_master WHERE id = ?', [params.tableId]);
  const tableCompany = (tableRows as { company_id: string }[])[0]?.company_id;
  if (tableCompany === undefined) throw Errors.notFound('Table');
  if (tableCompany !== params.companyId) throw Errors.forbidden();

  const id = newId();
  try {
    await conn.execute(
      'INSERT INTO table_session (id, table_id, opened_by, company_id, status) VALUES (?, ?, ?, ?, ?)',
      [id, params.tableId, params.openedBy, params.companyId, 'open'],
    );
    return id;
  } catch (err) {
    if ((err as { code?: string }).code !== 'ER_DUP_ENTRY') throw err;
    const [rows] = await conn.query(
      "SELECT id FROM table_session WHERE table_id = ? AND status = 'open' FOR UPDATE",
      [params.tableId],
    );
    const row = (rows as { id: string }[])[0];
    if (!row) throw err; // lost the race to a session that closed between insert and select — vanishingly rare
    return row.id;
  }
}

async function getOrCreateDefaultCover(
  conn: PoolConnection,
  params: { sessionId: string; companyId: string },
): Promise<string> {
  const [existing] = await conn.query(
    "SELECT id FROM table_cover WHERE table_session_id = ? AND cover_number = 1 AND status = 'active' LIMIT 1 FOR UPDATE",
    [params.sessionId],
  );
  const row = (existing as { id: string }[])[0];
  if (row) return row.id;

  const id = newId();
  await conn.execute(
    "INSERT INTO table_cover (id, table_session_id, company_id, cover_number, status) VALUES (?, ?, ?, 1, 'active')",
    [id, params.sessionId, params.companyId],
  );
  return id;
}

async function companyMeta(conn: PoolConnection, companyId: string) {
  const [rows] = await conn.query('SELECT company_code, timezone FROM company_master WHERE id = ?', [companyId]);
  const row = (rows as { company_code: string; timezone: string }[])[0];
  if (!row) throw Errors.notFound('Company');
  return row;
}

/** The order-taking transaction: get/create session -> get/create cover ->
 * validate + price the cart -> get/create the open bill -> insert bill_items
 * -> recompute bill totals from the DB (never "previous + new", so there's no
 * drift) -> allocate + insert the KOT -> deduct recipe stock. One commit.
 * See docs/backend-migration/PLAN.md §4.3. */
export async function saveOrderWithKot(
  app: FastifyInstance,
  params: {
    companyId: string;
    tableId: string;
    openedBy: string;
    cart: z.infer<typeof CartItemInput>[];
    coverId?: string | null;
  },
) {
  return withTransaction(app.db, async (conn) => {
    const sessionId = await getOrCreateOpenSession(conn, {
      companyId: params.companyId,
      tableId: params.tableId,
      openedBy: params.openedBy,
    });
    const effectiveCoverId =
      params.coverId ?? (await getOrCreateDefaultCover(conn, { sessionId, companyId: params.companyId }));

    // Validate every item in the cart actually belongs to this company —
    // never trust ids the client sends without checking tenancy.
    const itemIds = [...new Set(params.cart.map((c) => c.item_id))];
    const [validRows] = await conn.query(
      `SELECT id FROM item_master WHERE company_id = ? AND id IN (${itemIds.map(() => '?').join(',')})`,
      [params.companyId, ...itemIds],
    );
    if ((validRows as Row[]).length !== itemIds.length) {
      throw Errors.badRequest('One or more items do not belong to this company.');
    }

    const billItemRows = params.cart.map((ci) => {
      const { cgst, sgst, gross } = splitGst(ci.qty, ci.rate, ci.gst_rate, ci.is_taxable);
      return {
        id: newId(),
        item_id: ci.item_id,
        variant_id: ci.variant_id ?? null,
        item_name_snapshot: ci.item_name,
        rate_snapshot: ci.rate,
        qty: ci.qty,
        gross_amount: gross,
        discount_amount: 0,
        hsn_code_snapshot: ci.hsn_code ?? null,
        gst_rate_snapshot: ci.gst_rate,
        cgst_amount: cgst,
        sgst_amount: sgst,
        igst_amount: 0,
        net_amount: round2(gross + cgst + sgst),
        notes: ci.notes ?? null,
        qty_for_kot: ci.qty,
      };
    });

    const [existingBills] = await conn.query(
      "SELECT id FROM bill_master WHERE table_session_id = ? AND cover_id = ? AND status = 'open' LIMIT 1 FOR UPDATE",
      [sessionId, effectiveCoverId],
    );
    const existing = (existingBills as { id: string }[])[0];
    const meta = await companyMeta(conn, params.companyId);

    let billId: string;
    if (existing) {
      billId = existing.id;
    } else {
      billId = newId();
      const billNumber = await allocateBillNumber(conn, params.companyId, meta.company_code, meta.timezone);
      await conn.execute(
        `INSERT INTO bill_master (id, company_id, billed_by, table_session_id, cover_id, bill_number, bill_type, status)
         VALUES (?, ?, ?, ?, ?, ?, 'dine_in', 'open')`,
        [billId, params.companyId, params.openedBy, sessionId, effectiveCoverId, billNumber],
      );
    }

    for (const row of billItemRows) {
      await conn.execute(
        `INSERT INTO bill_item
           (id, bill_id, item_id, variant_id, item_name_snapshot, rate_snapshot, qty, gross_amount,
            discount_amount, hsn_code_snapshot, gst_rate_snapshot, cgst_amount, sgst_amount, igst_amount, net_amount, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.id, billId, row.item_id, row.variant_id, row.item_name_snapshot, row.rate_snapshot, row.qty,
          row.gross_amount, row.discount_amount, row.hsn_code_snapshot, row.gst_rate_snapshot, row.cgst_amount,
          row.sgst_amount, row.igst_amount, row.net_amount, row.notes,
        ],
      );
    }

    // Recomputed from every bill_item row on the bill (not "previous total +
    // this order"), so a concurrent edit elsewhere can never drift it.
    const [totalsRows] = await conn.query(
      'SELECT COALESCE(SUM(gross_amount),0) AS subtotal, COALESCE(SUM(cgst_amount),0) AS cgst, COALESCE(SUM(sgst_amount),0) AS sgst FROM bill_item WHERE bill_id = ?',
      [billId],
    );
    // A bare SUM()/COALESCE aggregate with no GROUP BY always returns exactly
    // one row, even over zero matching bill_items (COALESCE floors it at 0).
    const t = (totalsRows as { subtotal: number; cgst: number; sgst: number }[])[0]!;
    const totalAmount = round2(t.subtotal + t.cgst + t.sgst);
    await conn.execute(
      'UPDATE bill_master SET subtotal = ?, taxable_amount = ?, cgst_amount = ?, sgst_amount = ?, total_amount = ? WHERE id = ?',
      [t.subtotal, t.subtotal, t.cgst, t.sgst, totalAmount, billId],
    );

    const kotNumber = await allocateKotNumber(conn, params.companyId, meta.timezone);
    const kotId = newId();
    await conn.execute(
      `INSERT INTO kot_master (id, company_id, bill_id, table_session_id, cover_id, kot_number, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
      [kotId, params.companyId, billId, sessionId, effectiveCoverId, kotNumber, params.openedBy],
    );
    for (const row of billItemRows) {
      await conn.execute(
        'INSERT INTO kot_item (id, kot_id, bill_item_id, qty, notes, status) VALUES (?, ?, ?, ?, ?, ?)',
        [newId(), kotId, row.id, row.qty_for_kot, row.notes, 'pending'],
      );
    }

    // Recipe stock deduction — replaces the Postgres trigger `deduct_stock_on_kot`
    // (see schema comment); set-based so it costs one round trip regardless of
    // how many ingredients a variant's recipe has.
    await conn.execute(
      `INSERT INTO stock_ledger (id, company_id, raw_material_id, movement_type, qty, kot_item_id, staff_id, note)
       SELECT UUID(), ?, vr.raw_material_id, 'consumed', -(vr.qty_per_unit * ki.qty), ki.id, ?, 'auto KOT deduction'
         FROM kot_item ki
         JOIN bill_item bi ON bi.id = ki.bill_item_id
         JOIN variant_recipe vr ON vr.item_variant_id = bi.variant_id
        WHERE ki.kot_id = ?`,
      [params.companyId, params.openedBy, kotId],
    );

    return { sessionId, coverId: effectiveCoverId, kotId, kotNumber, billId };
  });
}

export async function getOrderSummaryForTable(app: FastifyInstance, tableId: string, companyId: string) {
  const [sessions] = await app.db.query(
    "SELECT id FROM table_session WHERE table_id = ? AND company_id = ? AND status = 'open' LIMIT 1",
    [tableId, companyId],
  );
  const session = (sessions as { id: string }[])[0];
  if (!session) return null;

  const [bills] = await app.db.query(
    "SELECT id, subtotal, total_amount, cgst_amount, sgst_amount FROM bill_master WHERE table_session_id = ? AND status = 'open' LIMIT 1",
    [session.id],
  );
  const bill = (bills as Row[])[0];
  if (!bill) return { session_id: session.id, ordered_items: [] };

  const [items] = await app.db.query(
    'SELECT item_name_snapshot, qty, rate_snapshot FROM bill_item WHERE bill_id = ?',
    [bill.id],
  );
  return { ...bill, session_id: session.id, ordered_items: items };
}

export async function checkoutTable(
  app: FastifyInstance,
  params: { tableId: string; companyId: string; paymentMode: string; discountPercent: number },
) {
  return withTransaction(app.db, async (conn) => {
    const [sessions] = await conn.query(
      "SELECT id FROM table_session WHERE table_id = ? AND company_id = ? AND status = 'open' LIMIT 1 FOR UPDATE",
      [params.tableId, params.companyId],
    );
    const session = (sessions as { id: string }[])[0];
    if (!session) throw Errors.badRequest('No open order found for this table');

    const [bills] = await conn.query(
      "SELECT id, total_amount FROM bill_master WHERE table_session_id = ? AND status = 'open' LIMIT 1 FOR UPDATE",
      [session.id],
    );
    const bill = (bills as { id: string; total_amount: number }[])[0];
    if (!bill) throw Errors.badRequest('No open bill found for this table');

    const discountAmount = round2((bill.total_amount * params.discountPercent) / 100);
    const finalTotal = round2(bill.total_amount - discountAmount);
    const now = new Date();

    await conn.execute(
      'UPDATE bill_master SET status = ?, payment_mode = ?, discount_amount = ?, total_amount = ?, bill_date = ? WHERE id = ?',
      ['paid', params.paymentMode.toLowerCase(), discountAmount, finalTotal, now, bill.id],
    );
    await conn.execute("UPDATE table_session SET status = 'billed', closed_at = ? WHERE id = ?", [now, session.id]);
  });
}
