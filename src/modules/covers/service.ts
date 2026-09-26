import type { FastifyInstance } from 'fastify';
import { newId } from '../../lib/ids.js';
import { withTransaction } from '../../lib/tx.js';
import { round2 } from '../../lib/money.js';
import { Errors } from '../../plugins/errors.js';
import { assertOwnedByCompany } from '../../lib/tenant.js';

type Row = Record<string, unknown>;

export async function getCoversForSession(app: FastifyInstance, sessionId: string, companyId: string) {
  const [rows] = await app.db.query(
    'SELECT * FROM table_cover WHERE table_session_id = ? AND company_id = ? ORDER BY cover_number',
    [sessionId, companyId],
  );
  return rows;
}

function billTotal(b: { total_amount?: number; subtotal?: number; cgst_amount?: number; sgst_amount?: number }): number {
  return b.total_amount ?? (b.subtotal ?? 0) + (b.cgst_amount ?? 0) + (b.sgst_amount ?? 0);
}

export async function getCoverTotals(app: FastifyInstance, sessionId: string, companyId: string) {
  const [rows] = await app.db.query(
    "SELECT cover_id, total_amount, subtotal, cgst_amount, sgst_amount FROM bill_master WHERE table_session_id = ? AND company_id = ? AND status = 'open'",
    [sessionId, companyId],
  );
  const totals: Record<string, number> = {};
  for (const b of rows as (Row & { cover_id: string | null })[]) {
    if (!b.cover_id) continue;
    totals[b.cover_id] = round2((totals[b.cover_id] ?? 0) + billTotal(b as never));
  }
  return totals;
}

export async function getDetailedItemsForSession(app: FastifyInstance, sessionId: string, companyId: string) {
  const [billRows] = await app.db.query(
    'SELECT id, cover_id FROM bill_master WHERE table_session_id = ? AND company_id = ?',
    [sessionId, companyId],
  );
  const bills = billRows as { id: string; cover_id: string | null }[];
  if (bills.length === 0) return [];

  const billIds = bills.map((b) => b.id);
  const coverIdByBill = new Map(bills.map((b) => [b.id, b.cover_id]));

  const [itemRows] = await app.db.query(
    `SELECT item_name_snapshot, qty, rate_snapshot, bill_id FROM bill_item WHERE bill_id IN (${billIds.map(() => '?').join(',')})`,
    billIds,
  );

  const coverIds = [...new Set(bills.map((b) => b.cover_id).filter((x): x is string => !!x))];
  const coverDetails = new Map<string, { cover_number: number; label: string | null }>();
  if (coverIds.length > 0) {
    const [coverRows] = await app.db.query(
      `SELECT id, cover_number, label FROM table_cover WHERE id IN (${coverIds.map(() => '?').join(',')})`,
      coverIds,
    );
    for (const c of coverRows as { id: string; cover_number: number; label: string | null }[]) {
      coverDetails.set(c.id, c);
    }
  }

  return (itemRows as { item_name_snapshot: string | null; qty: number; rate_snapshot: number; bill_id: string }[]).map(
    (item) => {
      const coverId = coverIdByBill.get(item.bill_id) ?? null;
      const cover = coverId ? coverDetails.get(coverId) : undefined;
      return {
        item_name: item.item_name_snapshot ?? '—',
        qty: Math.trunc(item.qty ?? 1),
        rate: item.rate_snapshot ?? 0,
        cover_id: coverId,
        cover_number: cover?.cover_number ?? null,
        cover_label: cover?.label ?? null,
      };
    },
  );
}

export async function createCover(
  app: FastifyInstance,
  params: { sessionId: string; companyId: string; coverNumber: number; label?: string | null; pax: number },
) {
  // The session's own company must match the caller — otherwise `company_id`
  // on the new cover (forced to the caller's own) and `table_session_id`
  // (pointing at someone else's session) would disagree, corrupting the
  // company-scoped reads that join through it.
  await assertOwnedByCompany(app, 'SELECT company_id FROM table_session WHERE id = ?', params.sessionId, params.companyId, 'Table session');
  const id = newId();
  await app.db.execute(
    'INSERT INTO table_cover (id, table_session_id, company_id, cover_number, label, pax, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, params.sessionId, params.companyId, params.coverNumber, params.label ?? null, params.pax, 'active'],
  );
  const [rows] = await app.db.query('SELECT * FROM table_cover WHERE id = ?', [id]);
  return (rows as Row[])[0];
}

export async function deleteCover(app: FastifyInstance, coverId: string, companyId: string) {
  await assertOwnedByCompany(app, 'SELECT company_id FROM table_cover WHERE id = ?', coverId, companyId, 'Cover');
  await app.db.execute('DELETE FROM table_cover WHERE id = ?', [coverId]);
}

/** Pays a cover's open bill and closes the session once every cover is done —
 * a single transaction, unlike the old client's 3 sequential (non-atomic)
 * calls. */
export async function checkoutCover(
  app: FastifyInstance,
  params: { coverId: string; sessionId: string; companyId: string; paymentMode: string; discountPercent: number },
) {
  return withTransaction(app.db, async (conn) => {
    const [coverRows] = await conn.query('SELECT company_id FROM table_cover WHERE id = ?', [params.coverId]);
    const coverCompany = (coverRows as { company_id: string }[])[0]?.company_id;
    if (coverCompany === undefined) throw Errors.notFound('Cover');
    if (coverCompany !== params.companyId) throw Errors.forbidden();

    const [bills] = await conn.query(
      "SELECT id, total_amount FROM bill_master WHERE cover_id = ? AND status = 'open' LIMIT 1 FOR UPDATE",
      [params.coverId],
    );
    const bill = (bills as { id: string; total_amount: number }[])[0];
    if (!bill) throw Errors.badRequest('No open bill for this cover');

    const rawTotal = bill.total_amount ?? 0;
    const discountAmount = round2((rawTotal * params.discountPercent) / 100);
    const finalTotal = round2(rawTotal - discountAmount);
    const now = new Date();

    await conn.execute(
      'UPDATE bill_master SET status = ?, payment_mode = ?, discount_amount = ?, total_amount = ?, bill_date = ? WHERE id = ?',
      ['paid', params.paymentMode.toLowerCase(), discountAmount, finalTotal, now, bill.id],
    );
    await conn.execute("UPDATE table_cover SET status = 'billed' WHERE id = ?", [params.coverId]);

    const [activeCovers] = await conn.query(
      "SELECT id FROM table_cover WHERE table_session_id = ? AND status = 'active'",
      [params.sessionId],
    );
    if ((activeCovers as Row[]).length === 0) {
      await conn.execute("UPDATE table_session SET status = 'billed', closed_at = ? WHERE id = ?", [
        now,
        params.sessionId,
      ]);
    }
  });
}
