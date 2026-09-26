// One-time ETL: live Supabase (Postgres) -> MySQL (this backend).
//
// NOT executed against the real project as part of building this script —
// see docs/backend-migration/PLAN.md §7's stated boundary: the management
// token pasted into that planning session was flagged to be revoked, and a
// live export from production is a coordinated, maintenance-window action
// the user runs deliberately, not something to fire automatically. This file
// is written and structurally complete against the exact live schema
// documented in that plan (introspected 2026-09-19), but it has only been
// exercised in code review, never against real Supabase data.
//
// Requires a READ-ONLY Postgres role (see PLAN.md §6):
//   create role etl_ro with login password '...';
//   grant usage on schema public to etl_ro;
//   grant select on all tables in schema public to etl_ro;
//
// Usage:
//   SUPABASE_DB_URL=postgres://etl_ro:...@db.<ref>.supabase.co:5432/postgres \
//   DB_HOST=... DB_PORT=... DB_USER=... DB_PASSWORD=... DB_NAME=cafe \
//   npm run migrate:from-supabase -- --dry-run    # logs counts/mappings, writes nothing
//   npm run migrate:from-supabase                 # applies (idempotent — safe to re-run)
import 'dotenv/config';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { hash as argonHash } from '@node-rs/argon2';
import { createPool } from '../src/plugins/db.js';

const DRY_RUN = process.argv.includes('--dry-run');
const BATCH = 500;

interface Report {
  table: string;
  read: number;
  written: number;
  fixups: string[];
}
const report: Report[] = [];

function logTable(table: string, read: number, written: number, fixups: string[] = []) {
  report.push({ table, read, written, fixups });
  const suffix = fixups.length ? `  [${fixups.join('; ')}]` : '';
  console.log(`${DRY_RUN ? '[dry-run] ' : ''}${table}: read ${read}, ${DRY_RUN ? 'would write' : 'wrote'} ${written}${suffix}`);
}

/** Runs [fn] over every row from [sql] in batches of [BATCH], for tables too
 * large to hold in memory at once (bills/bill_item on a real café's data). */
async function forEachBatch(
  pg: pg.Pool,
  sql: string,
  fn: (rows: Record<string, unknown>[]) => Promise<void>,
): Promise<number> {
  let offset = 0;
  let total = 0;
  for (;;) {
    const { rows } = await pg.query(`${sql} LIMIT ${BATCH} OFFSET ${offset}`);
    if (rows.length === 0) break;
    await fn(rows);
    total += rows.length;
    offset += BATCH;
    if (rows.length < BATCH) break;
  }
  return total;
}

/** `INSERT ... ON DUPLICATE KEY UPDATE` on every column but the key —
 * idempotent, so a re-run (e.g. after a partial failure) never double-counts
 * or errors on rows already migrated. */
async function upsertBatch(
  my: mysql.Pool,
  table: string,
  columns: string[],
  rows: Record<string, unknown>[],
): Promise<void> {
  if (DRY_RUN || rows.length === 0) return;
  const placeholders = `(${columns.map(() => '?').join(',')})`;
  const updates = columns.filter((c) => c !== 'id').map((c) => `${c} = VALUES(${c})`).join(', ');
  const sql = `INSERT INTO ${table} (${columns.join(',')}) VALUES ${rows.map(() => placeholders).join(',')} ` +
    (updates ? `ON DUPLICATE KEY UPDATE ${updates}` : 'ON DUPLICATE KEY UPDATE id = id');
  const values = rows.flatMap((r) => columns.map((c) => r[c] ?? null));
  await my.execute(sql, values as any[]);
}

async function main() {
  const pgUrl = process.env.SUPABASE_DB_URL;
  if (!pgUrl) throw new Error('Set SUPABASE_DB_URL (a read-only Postgres connection string — see this file\'s header).');

  const source = new pg.Pool({ connectionString: pgUrl, max: 5 });
  const target = createPool();

  console.log(DRY_RUN ? '=== DRY RUN — no MySQL writes will be made ===' : '=== LIVE RUN — writing to MySQL ===');

  try {
    // ── 1. company_master ────────────────────────────────────────────────
    {
      const { rows } = await source.query(`SELECT * FROM company_master`);
      for (const r of rows) {
        await upsertBatch(target, 'company_master', [
          'id', 'company_code', 'company_name', 'address', 'city', 'state', 'country', 'phone', 'email',
          'has_gst', 'gstin', 'pan_number', 'has_table_management', 'has_item_variants', 'currency_code',
          'timezone', 'logo_url', 'is_active', 'created_at', 'show_item_images', 'is_verified',
        ], [r]);
      }
      logTable('company_master', rows.length, rows.length);
    }

    // ── 2. company_hsn ────────────────────────────────────────────────────
    {
      const { rows } = await source.query(`SELECT * FROM company_hsn`);
      await upsertBatch(target, 'company_hsn', [
        'id', 'company_id', 'hsn_code', 'description', 'gst_rate', 'cgst_rate', 'sgst_rate', 'igst_rate', 'is_active',
      ], rows);
      logTable('company_hsn', rows.length, rows.length);
    }

    // ── 3. company_print_config ──────────────────────────────────────────
    {
      const { rows } = await source.query(`SELECT * FROM company_print_config`);
      await upsertBatch(target, 'company_print_config', [
        'id', 'company_id', 'printer_type', 'paper_size', 'print_logo', 'print_gstin', 'print_hsn',
        'print_qr_code', 'header_text', 'footer_text', 'copies_bill', 'copies_kot', 'auto_print_kot', 'auto_print_bill',
      ], rows);
      logTable('company_print_config', rows.length, rows.length);
    }

    // ── 4. user_profiles — [FIX 1] hash plaintext passwords; [FIX 2] dedupe
    //      case-variant employee_code within a company (live conflict:
    //      DIV01 / div01 — see PLAN.md §3.2, §6). ─────────────────────────
    {
      const { rows } = await source.query(`SELECT * FROM user_profiles ORDER BY created_at`);
      const seenEmpCode = new Map<string, Set<string>>(); // company_id -> lowercased codes already used
      const fixups: string[] = [];
      const toWrite: Record<string, unknown>[] = [];
      for (const r of rows) {
        const companyKey = r.company_id ?? '(owner)';
        const used = seenEmpCode.get(companyKey) ?? new Set<string>();
        let empCode = r.employee_code as string;
        const lower = empCode.toLowerCase();
        if (used.has(lower)) {
          empCode = `${empCode}-2`;
          fixups.push(`employee_code ${r.employee_code} -> ${empCode} (company ${companyKey})`);
        }
        used.add(empCode.toLowerCase());
        seenEmpCode.set(companyKey, used);

        const passwordHash = await argonHash(r.password as string);
        if ((r.password as string).length < 8) {
          fixups.push(`user ${r.username}: password shorter than 8 chars (hashed as-is, not strengthened)`);
        }
        toWrite.push({ ...r, employee_code: empCode, password_hash: passwordHash });
      }
      await upsertBatch(target, 'user_profiles', [
        'id', 'company_id', 'employee_code', 'user_name', 'username', 'password_hash', 'user_role',
        'mob_number', 'user_email', 'user_active', 'last_login', 'created_at', 'avatar_url', 'pan_no',
        'aadhaar_no', 'address', 'dob', 'date_of_join', 'updated_at', 'is_login',
      ], toWrite);
      logTable('user_profiles', rows.length, toWrite.length, fixups);
    }

    // ── 5. user_permission / user_preference ─────────────────────────────
    {
      const { rows } = await source.query(`SELECT * FROM user_permission`);
      await upsertBatch(target, 'user_permission', [
        'id', 'user_id', 'can_view_dashboard', 'can_create_bill', 'can_edit_bill', 'can_cancel_bill',
        'can_apply_discount', 'can_manage_items', 'can_manage_tables', 'can_view_reports', 'can_manage_users',
        'can_manage_settings', 'can_void_items', 'can_manage_stock',
      ], rows);
      logTable('user_permission', rows.length, rows.length);
    }
    {
      const { rows } = await source.query(`SELECT * FROM user_preference`);
      await upsertBatch(target, 'user_preference', [
        'id', 'user_id', 'ui_theme_type', 'primary_color', 'accent_color', 'font_size', 'layout_mode',
        'dark_mode', 'chosen_at',
      ], rows);
      logTable('user_preference', rows.length, rows.length);
    }

    // ── 6. table_master — [FIX 3] dedupe (company_id, table_number) if any
    //      exist (none did as of the 2026-09-19 snapshot; guarded anyway). ─
    {
      const { rows } = await source.query(`SELECT * FROM table_master`);
      const seen = new Set<string>();
      const fixups: string[] = [];
      for (const r of rows) {
        const key = `${r.company_id}|${(r.table_number as string).toLowerCase()}`;
        if (seen.has(key)) {
          r.table_number = `${r.table_number}-DUP${r.id.slice(0, 4)}`;
          fixups.push(`renamed duplicate table_number -> ${r.table_number}`);
        }
        seen.add(key);
      }
      await upsertBatch(target, 'table_master', [
        'id', 'company_id', 'table_number', 'section', 'seating_capacity', 'qr_code', 'is_active',
      ], rows);
      logTable('table_master', rows.length, rows.length, fixups);
    }

    // ── 7. table_session — [FIX 4] the new schema allows only one OPEN
    //      session per table; force any but the most-recent open session per
    //      table to 'closed' before insert (none existed live, guarded anyway). ─
    {
      const { rows } = await source.query(`SELECT * FROM table_session ORDER BY opened_at`);
      const openSeen = new Set<string>();
      const fixups: string[] = [];
      for (const r of rows.slice().reverse()) {
        if (r.status === 'open') {
          if (openSeen.has(r.table_id as string)) {
            r.status = 'closed';
            fixups.push(`session ${r.id}: forced closed (table already had a newer open session)`);
          }
          openSeen.add(r.table_id as string);
        }
      }
      await upsertBatch(target, 'table_session', [
        'id', 'table_id', 'opened_by', 'company_id', 'opened_at', 'closed_at', 'status', 'total_pax',
      ], rows);
      logTable('table_session', rows.length, rows.length, fixups);
    }

    // ── 8. table_cover ────────────────────────────────────────────────────
    {
      const { rows } = await source.query(`SELECT * FROM table_cover`);
      await upsertBatch(target, 'table_cover', [
        'id', 'table_session_id', 'company_id', 'cover_number', 'label', 'pax', 'status', 'created_at',
      ], rows);
      logTable('table_cover', rows.length, rows.length);
    }

    // ── 9. item_master — [FIX 5] dedupe (company_id, item_code) if any exist
    //      (none did live). ──────────────────────────────────────────────
    {
      const { rows } = await source.query(`SELECT * FROM item_master`);
      const seen = new Set<string>();
      const fixups: string[] = [];
      for (const r of rows) {
        const key = `${r.company_id}|${(r.item_code as string).toLowerCase()}`;
        if (seen.has(key)) {
          r.item_code = `${r.item_code}-DUP${(r.id as string).slice(0, 4)}`;
          fixups.push(`renamed duplicate item_code -> ${r.item_code}`);
        }
        seen.add(key);
      }
      const columns = [
        'id', 'company_id', 'hsn_id', 'item_code', 'item_name', 'description', 'base_rate', 'has_variants',
        'is_taxable', 'is_active', 'image_url', 'display_order', 'section_label', 'color_tag', 'food_type',
        'short_name', 'local_name', 'search_keywords', 'badge', 'is_featured', 'is_recommended',
        'preparation_time', 'is_online_visible', 'is_pos_visible', 'is_qr_visible', 'is_self_order_visible',
        'stock_enabled', 'unlimited_stock', 'sold_out', 'packing_charge', 'loyalty_enabled', 'discount_allowed',
        'updated_at', 'updated_by', 'sync_version',
        // default_variant_id deliberately excluded here — item_variant rows
        // don't exist yet at this point in the import order; set in step 10.
      ];
      await upsertBatch(target, 'item_master', columns, rows);
      logTable('item_master', rows.length, rows.length, fixups);
    }

    // ── 10. item_variant, then backfill item_master.default_variant_id ───
    {
      const { rows } = await source.query(`SELECT * FROM item_variant`);
      await upsertBatch(target, 'item_variant', [
        'id', 'item_id', 'variant_name', 'rate_override', 'is_active', 'image_url', 'hsn_id', 'inclusive_rate',
        'is_rate_inclusive', 'description', 'display_order', 'is_available', 'base_rate', 'sku', 'barcode',
        'short_name', 'local_name', 'print_name', 'kitchen_name', 'calories', 'portion_size', 'unit',
        'preparation_time', 'is_default', 'is_popular', 'is_new', 'is_recommended', 'badge', 'online_visible',
        'pos_visible', 'qr_visible', 'self_order_visible', 'dine_in_available', 'takeaway_available',
        'delivery_available', 'stock_enabled', 'unlimited_stock', 'current_stock', 'reorder_level',
        'packing_charge', 'service_charge', 'search_keywords', 'display_color', 'sort_priority', 'updated_at',
        'updated_by', 'food_type',
      ], rows);
      logTable('item_variant', rows.length, rows.length);

      if (!DRY_RUN) {
        const { rows: groups } = await source.query(`SELECT id, default_variant_id FROM item_master WHERE default_variant_id IS NOT NULL`);
        for (const g of groups) {
          await target.execute('UPDATE item_master SET default_variant_id = ? WHERE id = ?', [g.default_variant_id, g.id]);
        }
        console.log(`item_master.default_variant_id: backfilled ${groups.length} pointers`);
      }
    }

    // ── 11. bill_master — [FIX 8] dedupe (company_id, bill_number); the live
    //      snapshot had 8 legacy `BL-...` numbers, all already globally
    //      unique, so no rename is expected but the guard runs regardless. ─
    let billNumberFixups: string[] = [];
    {
      const total = await forEachBatch(source, `SELECT * FROM bill_master ORDER BY bill_date`, async (rows) => {
        const seen = new Set<string>();
        for (const r of rows) {
          const key = `${r.company_id}|${(r.bill_number as string).toLowerCase()}`;
          if (seen.has(key)) {
            r.bill_number = `${r.bill_number}-DUP${(r.id as string).slice(0, 4)}`;
            billNumberFixups.push(`renamed duplicate bill_number -> ${r.bill_number}`);
          }
          seen.add(key);
        }
        await upsertBatch(target, 'bill_master', [
          'id', 'company_id', 'table_session_id', 'billed_by', 'bill_number', 'bill_type', 'bill_date',
          'subtotal', 'discount_amount', 'discount_type', 'taxable_amount', 'cgst_amount', 'sgst_amount',
          'igst_amount', 'total_amount', 'amount_paid', 'change_amount', 'payment_mode', 'payment_ref',
          'status', 'notes', 'is_printed', 'printed_at', 'cover_id',
        ], rows);
      });
      logTable('bill_master', total, total, billNumberFixups);
    }

    // ── 12. bill_item ─────────────────────────────────────────────────────
    {
      const total = await forEachBatch(source, `SELECT * FROM bill_item ORDER BY id`, (rows) =>
        upsertBatch(target, 'bill_item', [
          'id', 'bill_id', 'item_id', 'variant_id', 'item_name_snapshot', 'rate_snapshot', 'qty',
          'gross_amount', 'discount_amount', 'hsn_code_snapshot', 'gst_rate_snapshot', 'cgst_amount',
          'sgst_amount', 'igst_amount', 'net_amount', 'notes', 'kot_status', 'kot_printed_at',
        ], rows));
      logTable('bill_item', total, total);
    }

    // ── 13. kot_master — [FIX 10] dedupe (company_id, kot_number); the live
    //      snapshot has 5 real duplicate pairs from the old client-side race. ─
    let kotNumberFixups: string[] = [];
    {
      const { rows } = await source.query(`SELECT * FROM kot_master ORDER BY created_at`);
      const seen = new Set<string>();
      for (const r of rows) {
        const key = `${r.company_id}|${(r.kot_number as string).toLowerCase()}`;
        if (seen.has(key)) {
          r.kot_number = `${r.kot_number}-D2`;
          kotNumberFixups.push(`renamed duplicate kot_number -> ${r.kot_number}`);
        }
        seen.add(key);
      }
      await upsertBatch(target, 'kot_master', [
        'id', 'bill_id', 'company_id', 'table_session_id', 'kot_number', 'created_at', 'created_by',
        'status', 'is_printed', 'cover_id',
      ], rows);
      logTable('kot_master', rows.length, rows.length, kotNumberFixups);
    }

    // ── 14. kot_item ──────────────────────────────────────────────────────
    {
      const { rows } = await source.query(`SELECT * FROM kot_item`);
      await upsertBatch(target, 'kot_item', ['id', 'kot_id', 'bill_item_id', 'qty', 'notes', 'status'], rows);
      logTable('kot_item', rows.length, rows.length);
    }

    // ── 15. inventory (empty live, per PLAN.md §1.2 — imported anyway in
    //      case this is re-run against a project that has since used it) ──
    for (const [table, cols] of [
      ['raw_material', ['id', 'company_id', 'name', 'unit', 'opening_stock', 'reorder_level', 'cost_per_unit', 'is_active', 'created_at']],
      ['variant_recipe', ['id', 'item_variant_id', 'raw_material_id', 'qty_per_unit']],
      ['stock_ledger', ['id', 'company_id', 'raw_material_id', 'movement_type', 'qty', 'kot_item_id', 'staff_id', 'note', 'shift_label', 'created_at']],
    ] as const) {
      const { rows } = await source.query(`SELECT * FROM ${table}`);
      await upsertBatch(target, table, [...cols], rows);
      logTable(table, rows.length, rows.length);
    }

    // ── 16. company_registration / super_admin_devices ───────────────────
    {
      const { rows } = await source.query(`SELECT * FROM company_registration`);
      await upsertBatch(target, 'company_registration', [
        'id', 'company_id', 'company_name', 'owner_name', 'owner_email', 'owner_phone', 'otp_code',
        'status', 'attempts', 'created_at', 'expires_at',
      ], rows);
      logTable('company_registration', rows.length, rows.length);
    }
    {
      const { rows } = await source.query(`SELECT * FROM super_admin_devices`);
      await upsertBatch(target, 'super_admin_devices', ['id', 'fcm_token', 'label', 'created_at', 'updated_at'], rows);
      logTable('super_admin_devices', rows.length, rows.length);
    }

    // ── 17. seed bill_counter / kot_counter from the migrated data, so the
    //      NEXT number issued continues the existing series without a gap
    //      or a collision (PLAN.md §3.2 [FIX 11], §6). ─────────────────────
    if (!DRY_RUN) {
      const [companies] = await target.query<mysql.RowDataPacket[]>('SELECT id, company_code, timezone FROM company_master');
      let seeded = 0;
      for (const c of companies) {
        const [bills] = await target.query<mysql.RowDataPacket[]>(
          `SELECT bill_number FROM bill_master WHERE company_id = ? AND bill_number REGEXP '^[^/]+/[0-9]{4}-[0-9]{1,2}/[0-9]+$'`,
          [c.id],
        );
        const byFy = new Map<string, number>();
        for (const b of bills) {
          const parts = (b.bill_number as string).split('/');
          const fy = parts[1]!;
          const seq = Number(parts[2]);
          byFy.set(fy, Math.max(byFy.get(fy) ?? 0, seq));
        }
        for (const [fy, maxSeq] of byFy) {
          await target.execute(
            'INSERT INTO bill_counter (company_id, fy, last_seq) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE last_seq = GREATEST(last_seq, VALUES(last_seq))',
            [c.id, fy, maxSeq],
          );
          seeded++;
        }

        const [kots] = await target.query<mysql.RowDataPacket[]>(
          `SELECT kot_number FROM kot_master WHERE company_id = ? AND kot_number REGEXP '^KOT/[0-9]{8}/[0-9]+$'`,
          [c.id],
        );
        const byDay = new Map<string, number>();
        for (const k of kots) {
          const parts = (k.kot_number as string).split('/');
          const day = parts[1]!; // YYYYMMDD
          const seq = Number(parts[2]);
          byDay.set(day, Math.max(byDay.get(day) ?? 0, seq));
        }
        for (const [day, maxSeq] of byDay) {
          const iso = `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}`;
          await target.execute(
            'INSERT INTO kot_counter (company_id, kot_day, last_seq) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE last_seq = GREATEST(last_seq, VALUES(last_seq))',
            [c.id, iso, maxSeq],
          );
          seeded++;
        }
      }
      console.log(`counters: seeded ${seeded} (company, period) rows so the next bill/KOT number continues the existing series`);
    }

    console.log('\n=== Summary ===');
    for (const r of report) {
      console.log(`  ${r.table}: ${r.read} read, ${r.written} written${r.fixups.length ? `, ${r.fixups.length} fixup(s)` : ''}`);
    }
    if (DRY_RUN) console.log('\nDry run only — nothing was written. Re-run without --dry-run to apply.');
  } finally {
    await source.end();
    await target.end();
  }
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
