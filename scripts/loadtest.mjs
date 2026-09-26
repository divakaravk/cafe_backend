// Quick load test matching docs/backend-migration/PLAN.md §8's scenario:
// many devices repeatedly polling GET /tables and GET /kots (the kitchen
// board + tables screen's 20s poll). Not a full production load test (that
// needs a provisioned target, not a laptop dev server) — this is a sanity
// check that the hot read paths don't fall over under concurrency.
import autocannon from 'autocannon';

const BASE = process.env.BASE ?? 'http://127.0.0.1:3099';

async function req(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null) };
}
const rand = () => Math.random().toString(36).slice(2, 8);

(async () => {
  const mysql = await import('mysql2/promise');
  const pool = mysql.createPool({ host: '127.0.0.1', port: Number(process.env.DB_PORT), user: 'root', database: 'cafe' });

  const code = 'C' + rand().toUpperCase();
  const reg = await req('POST', '/v1/public/registrations', { company: { company_code: code, company_name: 'Load Test Cafe' }, owner: {} });
  const [[row]] = await pool.query('SELECT otp_code FROM company_registration WHERE id = ?', [reg.json.registration_id]);
  const verify = await req('POST', `/v1/public/registrations/${reg.json.registration_id}/verify`, { code: row.otp_code });
  const username = 'loadadmin_' + rand();
  await req('POST', `/v1/public/registrations/${reg.json.registration_id}/admin`, { registration_token: verify.json.registration_token, user: { user_name: 'Load Admin', employee_code: 'L' + rand(), username, password: 'LoadSecret1' } });
  const login = await req('POST', '/v1/auth/login', { input: username, password: 'LoadSecret1' });
  const token = login.json.access_token;

  // Seed 15 tables so /tables returns a realistic-sized payload.
  for (let i = 0; i < 15; i++) {
    await req('POST', '/v1/tables', { table_number: `L${i}`, seating_capacity: 4 }, token);
  }

  for (const [name, path] of [['GET /v1/tables', '/v1/tables'], ['GET /v1/kots', '/v1/kots']]) {
    const result = await autocannon({
      url: BASE + path,
      connections: 50, // ~50 devices polling concurrently
      duration: 10,
      headers: { Authorization: `Bearer ${token}` },
    });
    console.log(`\n== ${name} — 50 connections, 10s ==`);
    console.log(`requests/sec: ${result.requests.average.toFixed(0)}   p50: ${result.latency.p50}ms   p95: ${result.latency.p97_5}ms   p99: ${result.latency.p99}ms   max: ${result.latency.max}ms`);
    console.log(`2xx: ${result['2xx']}   non-2xx: ${result.non2xx}   errors: ${result.errors}   timeouts: ${result.timeouts}`);
  }

  await pool.end();
})();
