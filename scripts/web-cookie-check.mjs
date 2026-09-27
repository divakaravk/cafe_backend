// Proves the web-only httpOnly refresh-token cookie flow added to
// modules/auth/routes.ts: a client sending X-Client-Platform: web gets the
// refresh token ONLY as a Set-Cookie (never in the JSON body), and can use
// that cookie — not a body field — to refresh and to log out.
const BASE = process.env.BASE ?? 'http://127.0.0.1:3099';
const rand = () => Math.random().toString(36).slice(2, 8);

function extractCookie(res, name) {
  const raw = res.headers.get('set-cookie') ?? '';
  const m = raw.match(new RegExp(`${name}=([^;]+)`));
  return m ? `${name}=${m[1]}` : null;
}

async function req(method, path, { body, headers = {}, cookie } = {}) {
  const h = { 'Content-Type': 'application/json', ...headers };
  if (cookie) h.Cookie = cookie;
  const res = await fetch(BASE + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  return { res, json: await res.json().catch(() => null) };
}

(async () => {
  const mysql = await import('mysql2/promise');
  const pool = mysql.createPool({ host: '127.0.0.1', port: Number(process.env.DB_PORT), user: 'root', database: 'cafe' });

  const code = 'W' + rand().toUpperCase();
  const reg = await req('POST', '/v1/public/registrations', { body: { company: { company_code: code, company_name: 'Web Co' }, owner: {} } });
  const [[row]] = await pool.query('SELECT otp_code FROM company_registration WHERE id = ?', [reg.json.registration_id]);
  const verify = await req('POST', `/v1/public/registrations/${reg.json.registration_id}/verify`, { body: { code: row.otp_code } });
  const username = 'u_' + rand();
  await req('POST', `/v1/public/registrations/${reg.json.registration_id}/admin`, {
    body: { registration_token: verify.json.registration_token, user: { user_name: 'Web Admin', employee_code: 'E' + rand(), username, password: 'Secret123!' } },
  });

  let pass = true;
  const check = (cond, label) => {
    console.log(cond ? 'PASS' : 'FAIL', label);
    if (!cond) pass = false;
  };

  // 1. Web login: no refresh_token in body, cookie is set httpOnly.
  const login = await req('POST', '/v1/auth/login', { body: { input: username, password: 'Secret123!' }, headers: { 'X-Client-Platform': 'web' } });
  check(login.res.status === 200, 'web login succeeds');
  check(login.json.refresh_token === undefined, 'web login response has NO refresh_token field');
  check(typeof login.json.access_token === 'string', 'web login still returns access_token');
  const setCookieHeader = login.res.headers.get('set-cookie') ?? '';
  check(setCookieHeader.includes('HttpOnly'), 'refresh cookie is HttpOnly');
  check(setCookieHeader.includes('SameSite=Strict'), 'refresh cookie is SameSite=Strict');
  const cookie1 = extractCookie(login.res, 'refresh_token');
  check(!!cookie1, 'refresh_token cookie was actually set');

  // 2. Native (mobile) login on the SAME account: refresh_token IS in the body, no special header.
  const nativeLogin = await req('POST', '/v1/auth/login', { body: { input: username, password: 'Secret123!', forceLogin: true } });
  check(typeof nativeLogin.json.refresh_token === 'string', 'native login still returns refresh_token in body (unchanged behavior)');

  // 3. Web refresh using ONLY the cookie (no body field).
  const refreshed = await req('POST', '/v1/auth/refresh', { body: {}, headers: { 'X-Client-Platform': 'web' }, cookie: cookie1 });
  check(refreshed.res.status === 200, 'web refresh via cookie-only succeeds');
  check(refreshed.json.refresh_token === undefined, 'web refresh response has NO refresh_token field');
  const cookie2 = extractCookie(refreshed.res, 'refresh_token');
  check(!!cookie2 && cookie2 !== cookie1, 'web refresh rotated to a NEW cookie value');

  // 4. The old cookie is now dead (rotation) — reusing it must fail.
  const reuse = await req('POST', '/v1/auth/refresh', { body: {}, headers: { 'X-Client-Platform': 'web' }, cookie: cookie1 });
  check(reuse.res.status === 401, 'reusing the rotated-away web cookie is rejected');

  // 5. Web logout clears the cookie.
  const logout = await req('POST', '/v1/auth/logout', { body: {}, headers: { 'X-Client-Platform': 'web' }, cookie: cookie2 });
  check(logout.res.status === 200, 'web logout succeeds');
  const clearHeader = logout.res.headers.get('set-cookie') ?? '';
  check(clearHeader.includes('refresh_token=;') || clearHeader.includes('Max-Age=0') || clearHeader.includes('Expires=Thu, 01 Jan 1970'), 'logout clears the refresh cookie');

  // 6. Refresh with no body and no cookie -> clean 401, not a crash.
  const empty = await req('POST', '/v1/auth/refresh', { body: {} });
  check(empty.res.status === 401, 'refresh with neither body token nor cookie -> 401');

  await pool.end();
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error('ERROR', e); process.exit(2); });
