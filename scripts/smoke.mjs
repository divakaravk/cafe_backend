// End-to-end smoke test against a running dev server: registration -> OTP ->
// first admin -> login -> item group+variant -> table -> order+KOT -> checkout
// -> bill list -> cancel -> kitchen board -> RBAC/tenant isolation checks.
// Talks to the real HTTP server (not in-process) so this exercises exactly
// what the Flutter RestBackend will call.
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
  // ---- health
  const health = await req('GET', '/healthz');
  ok('GET /healthz', health.status === 200 && health.json.ok === true);
  const ready = await req('GET', '/readyz');
  ok('GET /readyz (DB reachable)', ready.status === 200 && ready.json.ok === true);
  const time = await req('GET', '/v1/time');
  ok('GET /v1/time', time.status === 200 && !!Date.parse(time.json.now));

  // ---- company self-registration -> OTP -> first admin
  const code = 'C' + rand().toUpperCase();
  const reg = await req('POST', '/v1/public/registrations', {
    company: { company_code: code, company_name: 'Smoke Test Cafe' },
    owner: { owner_name: 'Owner', owner_email: 'owner@example.com' },
  });
  ok('POST /public/registrations', reg.status === 200 && reg.json.registration_id && reg.json.company_id, JSON.stringify(reg.json));

  const badOtp = await req('POST', `/v1/public/registrations/${reg.json.registration_id}/verify`, { code: '000000' });
  ok('verify with WRONG otp is rejected', badOtp.status === 200 && badOtp.json.ok === false && badOtp.json.reason === 'invalid');

  // Read the real OTP straight from the DB via a temporary owner-bypass: since
  // we have no owner account yet, read it directly through mysql2 in a tiny
  // inline query instead of the API (this script owns the whole test DB).
  const mysql = await import('mysql2/promise');
  const dbCfg = { host: '127.0.0.1', port: Number(process.env.DB_PORT), user: 'root', database: 'cafe' };
  const pool = mysql.createPool(dbCfg);
  const [[regRow]] = await pool.query('SELECT otp_code FROM company_registration WHERE id = ?', [reg.json.registration_id]);
  const otp = regRow.otp_code;

  const verify = await req('POST', `/v1/public/registrations/${reg.json.registration_id}/verify`, { code: otp });
  ok('verify with correct otp activates the company', verify.status === 200 && verify.json.ok === true && !!verify.json.registration_token);

  const adminUsername = 'admin_' + rand();
  const createAdmin = await req('POST', `/v1/public/registrations/${reg.json.registration_id}/admin`, {
    registration_token: verify.json.registration_token,
    user: { user_name: 'Admin User', employee_code: 'EMP' + rand(), username: adminUsername, password: 'Sup3rSecret!', user_email: 'admin@example.com' },
  });
  ok('POST .../admin creates the first admin', createAdmin.status === 200 && createAdmin.json.id, JSON.stringify(createAdmin.json));

  // Reusing an already-consumed verify+admin flow's token must fail (single-use intent,
  // even though the token itself is only time-limited, not stored/marked used — verifies at least expiry/signature path).
  const replayBadToken = await req('POST', `/v1/public/registrations/${reg.json.registration_id}/admin`, {
    registration_token: 'garbage.token',
    user: { user_name: 'X', employee_code: 'X1', username: 'x' + rand(), password: 'whatever1' },
  });
  ok('admin creation rejects a garbage registration token', replayBadToken.status === 401);

  // ---- login
  const login = await req('POST', '/v1/auth/login', { input: adminUsername, password: 'Sup3rSecret!' });
  ok('POST /auth/login succeeds', login.status === 200 && login.json.access_token && login.json.refresh_token, JSON.stringify(login.json));
  ok('login profile has no password field', login.json.profile && !('password' in login.json.profile) && !('password_hash' in login.json.profile));
  const token = login.json.access_token;
  const companyId = login.json.profile.company_id;

  const badPw = await req('POST', '/v1/auth/login', { input: adminUsername, password: 'wrong' });
  ok('wrong password -> exact Dart-parity message', badPw.status === 401 && badPw.json.error.message === 'Incorrect password. Please try again.');

  const noAccount = await req('POST', '/v1/auth/login', { input: 'no_such_user_' + rand(), password: 'x' });
  ok('unknown user -> exact Dart-parity message', noAccount.status === 404 && /No account found for/.test(noAccount.json.error.message));

  const already = await req('POST', '/v1/auth/login', { input: adminUsername, password: 'Sup3rSecret!' });
  ok('second login without forceLogin -> ALREADY_LOGGED_IN', already.status === 409 && already.json.error.code === 'ALREADY_LOGGED_IN' && already.json.error.message === 'ALREADY_LOGGED_IN');

  const forced = await req('POST', '/v1/auth/login', { input: adminUsername, password: 'Sup3rSecret!', forceLogin: true });
  ok('forceLogin=true succeeds while already logged in', forced.status === 200 && forced.json.access_token);

  // ---- refresh + reuse detection
  const refreshed = await req('POST', '/v1/auth/refresh', { refresh_token: forced.json.refresh_token });
  ok('POST /auth/refresh rotates the token', refreshed.status === 200 && refreshed.json.access_token && refreshed.json.refresh_token !== forced.json.refresh_token);
  const reuseOld = await req('POST', '/v1/auth/refresh', { refresh_token: forced.json.refresh_token });
  ok('reusing a rotated refresh token is rejected (401)', reuseOld.status === 401);
  const reuseAfterCompromise = await req('POST', '/v1/auth/refresh', { refresh_token: refreshed.json.refresh_token });
  ok('reuse-detection revokes the whole family (the NEW token is now dead too)', reuseAfterCompromise.status === 401);

  // ---- no-token / bad-token access
  const noToken = await req('GET', '/v1/tables');
  ok('GET /v1/tables with no token -> 401', noToken.status === 401);
  const badToken = await req('GET', '/v1/tables', undefined, 'not-a-real-token');
  ok('GET /v1/tables with a garbage token -> 401', badToken.status === 401);

  // ---- items: create group + variant
  const groupId = crypto.randomUUID();
  const group = await req('PUT', `/v1/items/${groupId}`, { data: { item_code: 'GRP1', item_name: 'Beverages', base_rate: 0, has_variants: true, is_taxable: true, is_active: true }, create_default_variant: true }, token);
  ok('PUT /items/:id creates a group + default variant atomically', group.status === 200 && group.json.default_variant_id, JSON.stringify(group.json));

  const variantId = crypto.randomUUID();
  const variant = await req('PUT', `/v1/variants/${variantId}`, { item_id: groupId, variant_name: 'Filter Coffee', base_rate: 40, is_active: true, is_available: true }, token);
  ok('PUT /variants/:id creates a sellable variant', variant.status === 200 && variant.json.id === variantId);

  const groups = await req('GET', '/v1/items?order=display', undefined, token);
  const fetchedGroup = groups.json.find((g) => g.id === groupId);
  ok('GET /items embeds item_variant[] and company_hsn', groups.status === 200 && Array.isArray(fetchedGroup?.item_variant) && fetchedGroup.item_variant.length === 2);

  // ---- table + order + KOT + checkout (the critical transaction)
  const table = await req('POST', '/v1/tables', { table_number: 'T' + rand(), seating_capacity: 4 }, token);
  ok('POST /tables creates a table', table.status === 200 && table.json.id);
  const tableId = table.json.id;

  const idemKey = crypto.randomUUID();
  const cart = [{ item_id: groupId, variant_id: variantId, item_name: 'Filter Coffee', rate: 40, qty: 2, gst_rate: 5, is_taxable: true }];
  const kot1 = await req('POST', '/v1/orders/kot', { table_id: tableId, cart }, token);
  const kot1WithIdem = await fetch(`${BASE}/v1/orders/kot`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'Idempotency-Key': idemKey }, body: JSON.stringify({ table_id: tableId, cart }) });
  const kot1WithIdemJson = await kot1WithIdem.json();
  ok('POST /orders/kot creates session+cover+bill+KOT', kot1.status === 200 && kot1.json.billId && kot1.json.kotNumber, JSON.stringify(kot1.json));

  const replay = await fetch(`${BASE}/v1/orders/kot`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'Idempotency-Key': idemKey }, body: JSON.stringify({ table_id: tableId, cart }) });
  const replayJson = await replay.json();
  ok('Idempotency-Key replay returns the SAME kotId (no duplicate KOT)', replay.status === 200 && replayJson.kotId === kot1WithIdemJson.kotId);

  const tables = await req('GET', '/v1/tables', undefined, token);
  const occ = tables.json.find((t) => t.id === tableId);
  ok('GET /tables shows the table occupied with the right total', tables.status === 200 && occ?.is_occupied === true && Number(occ.active_order_total) > 0, JSON.stringify(occ));

  const kots = await req('GET', '/v1/kots', undefined, token);
  const ourKot = kots.json.find((k) => k.id === kot1.json.kotId);
  ok('GET /kots embeds table_session.table_master + table_cover + kot_item.bill_item', kots.status === 200 && ourKot?.table_session?.table_master?.table_number && ourKot?.table_cover && ourKot?.kot_item?.[0]?.bill_item?.item_name_snapshot);

  const kotStatus = await req('PATCH', `/v1/kots/${kot1.json.kotId}`, { status: 'in_progress' }, token);
  ok('PATCH /kots/:id updates status', kotStatus.status === 200 && kotStatus.json.ok === true);

  const stock = await req('GET', '/v1/inventory/stock', undefined, token);
  ok('GET /inventory/stock works even with no raw materials yet', stock.status === 200 && Array.isArray(stock.json));

  const checkout = await req('POST', `/v1/tables/${tableId}/checkout`, { payment_mode: 'cash' }, token);
  ok('POST /tables/:id/checkout closes the bill+session', checkout.status === 200 && checkout.json.ok === true);

  const tablesAfter = await req('GET', '/v1/tables', undefined, token);
  const occAfter = tablesAfter.json.find((t) => t.id === tableId);
  ok('table is free again after checkout', occAfter?.is_occupied === false);

  // ---- bills list + cancel
  const bills = await req('GET', '/v1/bills', undefined, token);
  ok('GET /bills returns the checked-out bill with embeds', bills.status === 200 && bills.json.some((b) => b.id === kot1.json.billId && b.bill_item.length > 0 && b.table_session?.table_master?.table_number));

  const cancel = await req('POST', `/v1/bills/${kot1.json.billId}/cancel`, { reason: 'smoke test' }, token);
  ok('POST /bills/:id/cancel', cancel.status === 200 && cancel.json.ok === true);

  // ---- company
  const company = await req('GET', '/v1/company', undefined, token);
  ok('GET /company returns the caller\'s own company', company.status === 200 && company.json.company_name === 'Smoke Test Cafe');
  const companyPatch = await req('PATCH', '/v1/company', { city: 'Chennai' }, token);
  ok('PATCH /company', companyPatch.status === 200 && companyPatch.json.ok === true);
  const companyAfter = await req('GET', '/v1/company', undefined, token);
  ok('PATCH /company persisted', companyAfter.json.city === 'Chennai');
  const hsns = await req('GET', '/v1/company/hsn', undefined, token);
  ok('GET /company/hsn (empty is fine)', hsns.status === 200 && Array.isArray(hsns.json));

  // ---- inventory: raw material, recipe, adjustment, staff consumption, low-stock coercion
  const materialId = crypto.randomUUID();
  const material = await req('PUT', `/v1/inventory/materials/${materialId}`, { name: 'Milk', unit: 'litre', opening_stock: 1, reorder_level: 5 }, token);
  ok('PUT /inventory/materials/:id creates a raw material', material.status === 200 && material.json.id === materialId);

  const recipeId = crypto.randomUUID();
  const recipe = await req('PUT', `/v1/inventory/recipes/${recipeId}`, { item_variant_id: variantId, raw_material_id: materialId, qty_per_unit: 0.1 }, token);
  ok('PUT /inventory/recipes/:id links a variant to a material', recipe.status === 200 && recipe.json.id === recipeId);

  const recipeUsage = await req('GET', `/v1/inventory/materials/${materialId}/recipe-usage`, undefined, token);
  ok('GET recipe-usage counts the link', recipeUsage.status === 200 && recipeUsage.json.count === 1);

  const stockBefore = await req('GET', '/v1/inventory/stock', undefined, token);
  const milkBefore = stockBefore.json.find((m) => m.id === materialId);
  ok('GET /inventory/stock: is_low_stock coerced to a real boolean, and true (1 <= reorder 5)', typeof milkBefore.is_low_stock === 'boolean' && milkBefore.is_low_stock === true);

  const adjustment = await req('POST', '/v1/inventory/adjustments', { raw_material_id: materialId, qty: 10, movement_type: 'purchase', note: 'restock' }, token);
  ok('POST /inventory/adjustments', adjustment.status === 200 && adjustment.json.ok === true);
  const stockAfter = await req('GET', '/v1/inventory/stock', undefined, token);
  const milkAfter = stockAfter.json.find((m) => m.id === materialId);
  ok('stock reflects the adjustment (1 + 10 = 11) and is no longer low', milkAfter.current_stock === 11 && milkAfter.is_low_stock === false, JSON.stringify(milkAfter));

  const consumption = await req('GET', '/v1/inventory/staff-consumption', undefined, token);
  ok('GET /inventory/staff-consumption (real GROUP BY, empty is fine)', consumption.status === 200 && Array.isArray(consumption.json));

  const deleteMaterial = await req('DELETE', `/v1/inventory/materials/${materialId}`, undefined, token);
  ok('DELETE /inventory/materials/:id (soft delete)', deleteMaterial.status === 200);
  const stockPostDelete = await req('GET', '/v1/inventory/stock', undefined, token);
  ok('soft-deleted material drops out of the active stock view', !stockPostDelete.json.some((m) => m.id === materialId));

  // ---- uploads (real multipart, content-hash filename)
  const png1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const form = new FormData();
  form.append('file', new Blob([png1x1], { type: 'image/png' }), 'avatar.png');
  const uploadRes = await fetch(`${BASE}/v1/uploads/avatar`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
  const uploadJson = await uploadRes.json();
  ok('POST /uploads/avatar stores the file and returns a URL', uploadRes.status === 200 && /^http/.test(uploadJson.url), JSON.stringify(uploadJson));
  const fetchedUpload = await fetch(uploadJson.url);
  ok('the uploaded avatar is actually servable at its URL', fetchedUpload.status === 200 && (await fetchedUpload.arrayBuffer()).byteLength === png1x1.length);

  const form2 = new FormData();
  form2.append('file', new Blob([png1x1], { type: 'image/png' }), 'item.png');
  const itemUploadRes = await fetch(`${BASE}/v1/uploads/item-image?id=${groupId}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form2 });
  ok('POST /uploads/item-image (permission-gated upload)', itemUploadRes.status === 200);

  // ---- users: self-permissions, own-profile update, second user + login-status
  const ownPerms = await req('GET', `/v1/users/${login.json.profile.id}/permissions`, undefined, token);
  ok('GET own permissions needs no can_manage_users (self-access)', ownPerms.status === 200 && ownPerms.json.can_create_bill === true);

  const profilePatch = await req('PATCH', '/v1/users/me', { user_name: 'Renamed Admin', user_email: 'renamed@example.com' }, token);
  ok('PATCH /users/me', profilePatch.status === 200 && profilePatch.json.ok === true);

  const cashierUsername = 'cashier_' + rand();
  const newUser = await req('POST', '/v1/users', {
    user: { user_name: 'Cashier One', employee_code: 'CSH' + rand(), username: cashierUsername, user_role: 'cashier', password: 'Cashier$123' },
    permissions: { can_create_bill: true, can_view_dashboard: true, can_edit_bill: false, can_cancel_bill: false, can_apply_discount: false, can_manage_items: false, can_manage_tables: false, can_view_reports: false, can_manage_users: false, can_manage_settings: false, can_void_items: false, can_manage_stock: false },
  }, token);
  ok('POST /users creates a second user with permissions', newUser.status === 200 && newUser.json.id);

  const cashierLogin = await req('POST', '/v1/auth/login', { input: cashierUsername, password: 'Cashier$123' });
  ok('the new cashier can log in', cashierLogin.status === 200 && cashierLogin.json.access_token);
  const cashierBlocked = await req('POST', '/v1/tables', { table_number: 'CashierT1', seating_capacity: 2 }, cashierLogin.json.access_token);
  ok('cashier lacks can_manage_tables -> logged, not blocked (RBAC_ENFORCE=false in dev)', cashierBlocked.status === 200);

  const forceLogout = await req('POST', `/v1/users/${newUser.json.id}/force-logout`, undefined, token);
  ok('POST /users/:id/force-logout (admin action)', forceLogout.status === 200 && forceLogout.json.ok === true);
  const cashierAfterKick = await req('GET', '/v1/auth/session', undefined, cashierLogin.json.access_token);
  ok('force-logout takes effect on the SAME token within the cache window (no re-login needed)', cashierAfterKick.status === 401);

  const selfForceLogout = await req('POST', `/v1/users/${login.json.profile.id}/force-logout`, undefined, token);
  ok('an admin cannot force-logout themselves', selfForceLogout.status === 400);

  // ---- owner: seeded directly (matches the real bootstrap in db/seeds/owner.sql —
  // there is deliberately no self-service "become owner" endpoint).
  const { hash: argonHash } = await import('@node-rs/argon2');
  const ownerUsername = 'owner_' + rand();
  const ownerId = crypto.randomUUID();
  await pool.execute(
    "INSERT INTO user_profiles (id, company_id, employee_code, user_name, username, password_hash, user_role) VALUES (?, NULL, ?, 'Owner', ?, ?, 'owner')",
    [ownerId, 'OWN' + rand(), ownerUsername, await argonHash('Owner@12345')],
  );
  const ownerLogin = await req('POST', '/v1/auth/login', { input: ownerUsername, password: 'Owner@12345' });
  ok('a company-less owner (company_id NULL) can log in', ownerLogin.status === 200 && ownerLogin.json.profile.company_id === null, JSON.stringify(ownerLogin.json.profile));
  const ownerToken = ownerLogin.json.access_token;

  const nonOwnerListReg = await req('GET', '/v1/owner/registrations', undefined, token);
  ok('a regular admin cannot list registrations (owner-only)', nonOwnerListReg.status === 403);

  const regList = await req('GET', '/v1/owner/registrations', undefined, ownerToken);
  ok('GET /owner/registrations (owner) lists the earlier registration', regList.status === 200 && regList.json.some((r) => r.id === reg.json.registration_id));

  const codeApprove = 'C' + rand().toUpperCase();
  const regToApprove = await req('POST', '/v1/public/registrations', { company: { company_code: codeApprove, company_name: 'Approve Me Cafe' }, owner: {} });
  const approve = await req('POST', `/v1/owner/registrations/${regToApprove.json.registration_id}/approve`, undefined, ownerToken);
  ok('POST /owner/registrations/:id/approve activates without the OTP', approve.status === 200 && approve.json.ok === true);
  const [[approvedCompany]] = await pool.query('SELECT is_active, is_verified FROM company_master WHERE id = ?', [regToApprove.json.company_id]);
  ok('approved company is active + verified in the DB', approvedCompany.is_active === 1 && approvedCompany.is_verified === 1);

  const deviceReg = await req('PUT', '/v1/owner/devices', { token: 'fake-fcm-token-' + rand(), label: 'owner-phone' }, ownerToken);
  ok('PUT /owner/devices registers a push token (owner-only)', deviceReg.status === 200 && deviceReg.json.ok === true);

  // ---- second company: tenant isolation
  const code2 = 'C' + rand().toUpperCase();
  const reg2 = await req('POST', '/v1/public/registrations', { company: { company_code: code2, company_name: 'Other Cafe' }, owner: {} });
  const [[reg2Row]] = await pool.query('SELECT otp_code FROM company_registration WHERE id = ?', [reg2.json.registration_id]);
  const verify2 = await req('POST', `/v1/public/registrations/${reg2.json.registration_id}/verify`, { code: reg2Row.otp_code });
  const admin2Username = 'admin2_' + rand();
  await req('POST', `/v1/public/registrations/${reg2.json.registration_id}/admin`, { registration_token: verify2.json.registration_token, user: { user_name: 'Admin2', employee_code: 'E' + rand(), username: admin2Username, password: 'Other$ecret1' } });
  const login2 = await req('POST', '/v1/auth/login', { input: admin2Username, password: 'Other$ecret1' });
  const token2 = login2.json.access_token;

  const crossTables = await req('GET', '/v1/tables', undefined, token2);
  ok('company 2 sees ZERO of company 1\'s tables (tenant isolation)', crossTables.status === 200 && crossTables.json.length === 0);
  const crossForceLogout = await req('POST', `/v1/users/${login.json.profile.id}/force-logout`, undefined, token2);
  ok('company 2 admin cannot force-logout company 1\'s user (RBAC/tenant)', crossForceLogout.status !== 200);

  // ---- cross-tenant WRITE attacks: every "mutate an existing resource by :id"
  // endpoint fixed above, attacked with company 2's (legitimately admin, so
  // RBAC alone would let them through) token against company 1's resources.
  // Each of these failed with a 200 before the tenant.ts fixes.
  const attacks = [
    ['PUT item group (hijack)', 'PUT', `/v1/items/${groupId}`, { data: { item_code: 'HACK', item_name: 'Hacked', base_rate: 0 } }],
    ['DELETE item group', 'DELETE', `/v1/items/${groupId}`, undefined],
    ['PUT variant (hijack via item_id)', 'PUT', `/v1/variants/${variantId}`, { item_id: groupId, variant_name: 'Hacked', base_rate: 1 }],
    ['DELETE variant', 'DELETE', `/v1/variants/${variantId}`, undefined],
    ['POST default-variant', 'POST', `/v1/items/${groupId}/default-variant`, { variant_id: variantId }],
    ['PATCH table', 'PATCH', `/v1/tables/${tableId}`, { table_number: 'HACKED', seating_capacity: 1 }],
    ['DELETE cover', 'DELETE', `/v1/covers/${kot1.json.coverId}`, undefined],
    ['POST cover checkout', 'POST', `/v1/covers/${kot1.json.coverId}/checkout`, { session_id: kot1.json.sessionId }],
    ['POST table checkout', 'POST', `/v1/tables/${tableId}/checkout`, { payment_mode: 'cash' }],
    ['PATCH kot status', 'PATCH', `/v1/kots/${kot1.json.kotId}`, { status: 'done' }],
    ['POST bill cancel', 'POST', `/v1/bills/${kot1.json.billId}/cancel`, { reason: 'hack' }],
    ['PATCH bill', 'PATCH', `/v1/bills/${kot1.json.billId}`, { items: [], removed_item_ids: [], discount_amount: 0 }],
  ];
  for (const [label, method, path, body] of attacks) {
    const r = await req(method, path, body, token2);
    ok(`cross-tenant ${label} is blocked (not 200)`, r.status !== 200, `got ${r.status} ${JSON.stringify(r.json)}`);
  }
  const crossCovers = await req('GET', `/v1/sessions/${kot1.json.sessionId}/covers`, undefined, token2);
  ok('cross-tenant GET session covers returns EMPTY, not another company\'s data', crossCovers.status === 200 && crossCovers.json.length === 0);

  // fresh company-1 material + recipe line, attacked the same way (the ones
  // created earlier were already soft-deleted by the main flow)
  const material2Id = crypto.randomUUID();
  await req('PUT', `/v1/inventory/materials/${material2Id}`, { name: 'Sugar', unit: 'kg', opening_stock: 1, reorder_level: 1 }, token);
  const recipe2Id = crypto.randomUUID();
  await req('PUT', `/v1/inventory/recipes/${recipe2Id}`, { item_variant_id: variantId, raw_material_id: material2Id, qty_per_unit: 0.01 }, token);
  const materialAttacks = [
    ['PUT raw material (hijack)', 'PUT', `/v1/inventory/materials/${material2Id}`, { name: 'Hacked', unit: 'kg' }],
    ['DELETE raw material', 'DELETE', `/v1/inventory/materials/${material2Id}`, undefined],
    ['GET recipe-usage', 'GET', `/v1/inventory/materials/${material2Id}/recipe-usage`, undefined],
    ['GET recipes by variant', 'GET', `/v1/inventory/recipes?variant_id=${variantId}`, undefined],
    ['PUT recipe line (hijack)', 'PUT', `/v1/inventory/recipes/${recipe2Id}`, { item_variant_id: variantId, raw_material_id: material2Id, qty_per_unit: 99 }],
    ['DELETE recipe line', 'DELETE', `/v1/inventory/recipes/${recipe2Id}`, undefined],
  ];
  for (const [label, method, path, body] of materialAttacks) {
    const r = await req(method, path, body, token2);
    ok(`cross-tenant ${label} is blocked (not 200)`, r.status !== 200, `got ${r.status} ${JSON.stringify(r.json)}`);
  }

  // company 2 CAN manage its own freshly-created resources of the same kinds
  // (proves the fixes block cross-tenant access specifically, not everyone)
  const ownGroup = crypto.randomUUID();
  const ownGroupRes = await req('PUT', `/v1/items/${ownGroup}`, { data: { item_code: 'OWN1', item_name: 'Own Item', base_rate: 10 } }, token2);
  ok('company 2 can still manage its OWN item group', ownGroupRes.status === 200);

  await pool.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('SMOKE TEST ERROR', e); process.exit(2); });
