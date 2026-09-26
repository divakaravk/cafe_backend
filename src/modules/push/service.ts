import { createPrivateKey, sign } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { config } from '../../config.js';

/** Company-registration OTP push, ported from the Supabase project's
 * `send-registration-otp` Edge Function (supabase/functions/send-registration-otp).
 * That function hand-rolled the Google OAuth2 JWT-bearer flow instead of using
 * the `firebase-admin` SDK; this keeps the same approach (Node's built-in
 * `crypto` instead of Deno's Web Crypto) rather than pulling in the much
 * heavier SDK for one call type. No-ops when Firebase isn't configured —
 * mirrors `PushService`'s own guard on the Flutter side, so registration
 * itself never depends on push succeeding. */

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

async function getAccessToken(): Promise<string> {
  if (!config.firebase) throw new Error('Firebase not configured');
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: config.firebase.clientEmail,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };
  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claim))}`;
  const key = createPrivateKey(config.firebase.privateKey);
  const signature = sign('RSA-SHA256', Buffer.from(unsigned), key);
  const jwt = `${unsigned}.${b64url(signature)}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  });
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error(`OAuth failed: ${JSON.stringify(json)}`);
  return json.access_token;
}

async function sendToToken(accessToken: string, token: string, otp: string, company: string) {
  const res = await fetch(
    `https://fcm.googleapis.com/v1/projects/${config.firebase!.projectId}/messages:send`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          token,
          notification: { title: 'New company registration', body: `${company} requested access. Approval OTP: ${otp}` },
          data: { type: 'company_registration_otp', otp, company },
          android: { priority: 'HIGH', notification: { channel_id: 'company_registration', sound: 'default' } },
        },
      }),
    },
  );
  return { token, status: res.status };
}

export async function sendRegistrationOtpPush(app: FastifyInstance, params: { otp: string; companyName: string }) {
  if (!config.firebase) {
    app.log.info('push disabled (Firebase not configured) — skipping registration OTP push');
    return;
  }
  try {
    const [rows] = await app.db.query('SELECT fcm_token FROM super_admin_devices');
    const tokens = (rows as { fcm_token: string }[]).map((r) => r.fcm_token);
    if (tokens.length === 0) return;

    const accessToken = await getAccessToken();
    const results = await Promise.all(tokens.map((t) => sendToToken(accessToken, t, params.otp, params.companyName)));

    const dead = results.filter((r) => r.status === 404 || r.status === 400).map((r) => r.token);
    if (dead.length) {
      await app.db.execute(
        `DELETE FROM super_admin_devices WHERE fcm_token IN (${dead.map(() => '?').join(',')})`,
        dead,
      );
    }
  } catch (err) {
    // Best-effort, exactly like the Dart `PushService` guard — a push failure
    // must never affect the registration flow itself.
    app.log.warn({ err }, 'registration OTP push failed');
  }
}

export async function registerSuperAdminDevice(app: FastifyInstance, token: string, label?: string | null) {
  await app.db.execute(
    'INSERT INTO super_admin_devices (id, fcm_token, label) VALUES (UUID(), ?, ?) ON DUPLICATE KEY UPDATE label = VALUES(label), updated_at = NOW(3)',
    [token, label ?? null],
  );
}
