import type { PoolConnection } from 'mysql2/promise';

/** `{y, m, d}` (zero-padded) for "now" in an IANA timezone, with no extra
 * dependency — used so bill/KOT numbering follows the company's business day,
 * not the server's local clock or UTC. */
function companyLocalDateParts(timeZone: string): { y: string; m: string; d: string } {
  // en-CA formats as YYYY-MM-DD, which is trivial to split.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return { y: get('year'), m: get('month'), d: get('day') };
}

/** Financial year string exactly as the old Dart client formatted it
 * (April–March, no zero-padding quirk) — e.g. "2026-27" — so numbers issued by
 * the new backend continue the same series as the ones already in the DB. */
export function fiscalYearFor(timeZone: string): string {
  const { y, m } = companyLocalDateParts(timeZone);
  const year = Number(y);
  const month = Number(m);
  return month >= 4 ? `${year}-${(year + 1) % 100}` : `${year - 1}-${year % 100}`;
}

/** Company-local business date, as a `DATE`-compatible string — the key for `kot_counter`. */
export function businessDateFor(timeZone: string): string {
  const { y, m, d } = companyLocalDateParts(timeZone);
  return `${y}-${m}-${d}`;
}

const ALLOC_BILL_SEQ =
  'INSERT INTO bill_counter (company_id, fy, last_seq) VALUES (?, ?, LAST_INSERT_ID(1)) ' +
  'ON DUPLICATE KEY UPDATE last_seq = LAST_INSERT_ID(last_seq + 1)';

/** Atomically allocates the next bill number for (company, fiscal year).
 * Must be called on a connection that is inside the same transaction as the
 * bill insert — see docs/backend-migration/PLAN.md §3.5/§4.3: this is what
 * makes numbering gapless (a rolled-back bill burns no number) and race-free
 * (verified under 40-way concurrency in docs/backend-migration/verify/). */
export async function allocateBillNumber(
  conn: PoolConnection,
  companyId: string,
  companyCode: string,
  timeZone: string,
): Promise<string> {
  const fy = fiscalYearFor(timeZone);
  const prefix = companyCode.trim() || 'POS';
  const [result] = await conn.execute(ALLOC_BILL_SEQ, [companyId, fy]);
  const seq = (result as { insertId: number }).insertId;
  return `${prefix}/${fy}/${String(seq).padStart(3, '0')}`;
}

const ALLOC_KOT_SEQ =
  'INSERT INTO kot_counter (company_id, kot_day, last_seq) VALUES (?, ?, LAST_INSERT_ID(1)) ' +
  'ON DUPLICATE KEY UPDATE last_seq = LAST_INSERT_ID(last_seq + 1)';

/** Atomically allocates the next KOT number for (company, business day). */
export async function allocateKotNumber(
  conn: PoolConnection,
  companyId: string,
  timeZone: string,
): Promise<string> {
  const day = businessDateFor(timeZone);
  const [result] = await conn.execute(ALLOC_KOT_SEQ, [companyId, day]);
  const seq = (result as { insertId: number }).insertId;
  return `KOT/${day.replace(/-/g, '')}/${String(seq).padStart(3, '0')}`;
}
