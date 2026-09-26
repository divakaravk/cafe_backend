// Proves RBAC_ENFORCE=true actually blocks a permission-less user, and that
// the same admin/owner bypass + same-permission-holder still work. Run against
// a server started with RBAC_ENFORCE=true (see .env).
const BASE = process.env.BASE ?? 'http://127.0.0.1:3099';
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { (cond ? pass++ : fail++); console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? '  -> ' + extra : '')); };
async function req(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json };
}
const rand = () => Math.random().toString(36).slice(2, 8);

(async () => {
  const code = 'C' + rand().toUpperCase();
  const reg = await req('POST', '/v1/public/registrations', { company: { company_code: code, company_name: 'RBAC Test' }, owner: {} });
  const mysql = await import('mysql2/promise');
  const pool = mysql.createPool({ host: '127.0.0.1', port: Number(process.env.DB_PORT), user: 'root', database: 'cafe' });
  const [[row]] = await pool.query('SELECT otp_code FROM company_registration WHERE id = ?', [reg.json.registration_id]);
  const verify = await req('POST', `/v1/public/registrations/${reg.json.registration_id}/verify`, { code: row.otp_code });
  const adminUsername = 'admin_' + rand();
  await req('POST', `/v1/public/registrations/${reg.json.registration_id}/admin`, { registration_token: verify.json.registration_token, user: { user_name: 'Admin', employee_code: 'A' + rand(), username: adminUsername, password: 'AdminSecret1' } });
  const adminLogin = await req('POST', '/v1/auth/login', { input: adminUsername, password: 'AdminSecret1' });
  const adminToken = adminLogin.json.access_token;

  // A cashier with can_manage_tables=false explicitly.
  const cashierUsername = 'cashier_' + rand();
  await req('POST', '/v1/users', {
    user: { user_name: 'Cashier', employee_code: 'C' + rand(), username: cashierUsername, user_role: 'cashier', password: 'CashierSecret1' },
    permissions: { can_create_bill: true, can_view_dashboard: true, can_edit_bill: false, can_cancel_bill: false, can_apply_discount: false, can_manage_items: false, can_manage_tables: false, can_view_reports: false, can_manage_users: false, can_manage_settings: false, can_void_items: false, can_manage_stock: false },
  }, adminToken);
  const cashierLogin = await req('POST', '/v1/auth/login', { input: cashierUsername, password: 'CashierSecret1' });
  const cashierToken = cashierLogin.json.access_token;

  const blocked = await req('POST', '/v1/tables', { table_number: 'RBAC1', seating_capacity: 2 }, cashierToken);
  ok('RBAC_ENFORCE=true: cashier WITHOUT can_manage_tables is blocked (403)', blocked.status === 403, JSON.stringify(blocked.json));

  const adminAllowed = await req('POST', '/v1/tables', { table_number: 'RBAC2', seating_capacity: 2 }, adminToken);
  ok('RBAC_ENFORCE=true: admin still bypasses (permission checks never apply to admin)', adminAllowed.status === 200);

  // A second cashier WITH can_manage_tables=true should be let through.
  const cashier2Username = 'cashier2_' + rand();
  await req('POST', '/v1/users', {
    user: { user_name: 'Cashier2', employee_code: 'D' + rand(), username: cashier2Username, user_role: 'cashier', password: 'Cashier2Secret1' },
    permissions: { can_create_bill: true, can_view_dashboard: true, can_edit_bill: false, can_cancel_bill: false, can_apply_discount: false, can_manage_items: false, can_manage_tables: true, can_view_reports: false, can_manage_users: false, can_manage_settings: false, can_void_items: false, can_manage_stock: false },
  }, adminToken);
  const cashier2Login = await req('POST', '/v1/auth/login', { input: cashier2Username, password: 'Cashier2Secret1' });
  const allowed = await req('POST', '/v1/tables', { table_number: 'RBAC3', seating_capacity: 2 }, cashier2Login.json.access_token);
  ok('RBAC_ENFORCE=true: cashier WITH can_manage_tables=true is allowed', allowed.status === 200, JSON.stringify(allowed.json));

  await pool.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(2); });
