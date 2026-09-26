// Proves the fix in app.ts's rate-limit keyGenerator: two DIFFERENT
// authenticated users hitting the server from the SAME source IP (as two
// devices behind one NAT would) get INDEPENDENT budgets — one user being
// rate-limited must not 429 the other. The generic autocannon load test
// can't show this: it hammers with one token, so every request already
// shares one identity regardless of keying.
const BASE = process.env.BASE ?? 'http://127.0.0.1:3099';
async function req(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null) };
}
const rand = () => Math.random().toString(36).slice(2, 8);

async function makeCompanyAndAdmin(pool, label) {
  const code = 'C' + rand().toUpperCase();
  const reg = await req('POST', '/v1/public/registrations', { company: { company_code: code, company_name: label }, owner: {} });
  const [[row]] = await pool.query('SELECT otp_code FROM company_registration WHERE id = ?', [reg.json.registration_id]);
  const verify = await req('POST', `/v1/public/registrations/${reg.json.registration_id}/verify`, { code: row.otp_code });
  const username = 'u_' + rand();
  await req('POST', `/v1/public/registrations/${reg.json.registration_id}/admin`, { registration_token: verify.json.registration_token, user: { user_name: label, employee_code: 'E' + rand(), username, password: 'Secret123!' } });
  const login = await req('POST', '/v1/auth/login', { input: username, password: 'Secret123!' });
  return login.json.access_token;
}

(async () => {
  const mysql = await import('mysql2/promise');
  const pool = mysql.createPool({ host: '127.0.0.1', port: Number(process.env.DB_PORT), user: 'root', database: 'cafe' });

  const tokenA = await makeCompanyAndAdmin(pool, 'Tenant A');
  const tokenB = await makeCompanyAndAdmin(pool, 'Tenant B');

  console.log('Exhausting tenant A\'s budget with 320 rapid requests (all from this same process/IP)...');
  let aBlocked = 0;
  for (let i = 0; i < 320; i++) {
    const r = await req('GET', '/v1/tables', undefined, tokenA);
    if (r.status === 429) aBlocked++;
  }
  console.log(`tenant A: ${aBlocked}/320 requests got 429 (expected: some, once past 300)`);

  const bCheck = await req('GET', '/v1/tables', undefined, tokenB);
  const pass = aBlocked > 0 && bCheck.status === 200;
  console.log(pass ? 'PASS' : 'FAIL', 'tenant B is NOT rate-limited by tenant A exhausting their own budget from the same IP', `-> tenant B status: ${bCheck.status}`);

  await pool.end();
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error('ERROR', e); process.exit(2); });
