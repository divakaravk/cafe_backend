import Decimal from 'decimal.js';

Decimal.set({ rounding: Decimal.ROUND_HALF_UP });

/** Rounds to 2dp half-up (rupees/paise) — use before putting a computed total
 * into a JSON response. Storage rounding is handled by the DECIMAL column
 * itself (verified to match this exact rounding — see docs/backend-migration/PLAN.md §3.4). */
export function round2(n: number | string | Decimal): number {
  return new Decimal(n).toDecimalPlaces(2).toNumber();
}

/** Rounds to 3dp half-up (quantities: kg/l/pcs). */
export function round3(n: number | string | Decimal): number {
  return new Decimal(n).toDecimalPlaces(3).toNumber();
}

/** GST split identical to the Dart client's rule (`supabase_service.dart`
 * `_generateBillNumber`'s sibling tax logic): CGST and SGST are each half of
 * the item's total tax; IGST is not computed (no inter-state handling yet). */
export function splitGst(qty: number, rate: number, gstRatePercent: number, isTaxable: boolean) {
  const line = new Decimal(qty).times(rate);
  if (!isTaxable || gstRatePercent <= 0) {
    return { cgst: 0, sgst: 0, igst: 0, gross: round2(line) };
  }
  const tax = line.times(gstRatePercent).dividedBy(100);
  const half = tax.dividedBy(2);
  return {
    cgst: round2(half),
    sgst: round2(half),
    igst: 0,
    gross: round2(line),
  };
}
