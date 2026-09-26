const BASE = 'http://127.0.0.1:3099';
async function req(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  console.log(method, path, '->', res.status, text);
  try { return JSON.parse(text); } catch { return text; }
}
(async () => {
  const login = await req('POST', '/v1/auth/login', { input: 'admin_8njzwt', password: 'Sup3rSecret!', forceLogin: true });
  const token = login.access_token;

  const stock = await req('GET', '/v1/inventory/stock', undefined, token);
  const materialId = stock[0]?.id;
  console.log('materialId =', materialId);
  await req('DELETE', `/v1/inventory/materials/${materialId}`, undefined, token);

  const users = await req('GET', '/v1/users', undefined, token);
  const other = users.find((u) => u.id !== login.profile?.id);
  console.log('other user =', other?.id);
  await req('POST', `/v1/users/${other.id}/force-logout`, undefined, token);
})();
