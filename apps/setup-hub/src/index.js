import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAdminToken } from '@youpi/common';
import { generateQrSvg } from '@youpi/core';

// Setup Hub: one local page that shows the state of every YOUPI PG piece and
// drives the admin API on the operator's behalf. It binds to 127.0.0.1 only and
// keeps the admin token server-side, so the browser never needs it.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '../../..');
try {
  const envFile = path.join(rootDir, '.env');
  if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
} catch {}

const PORT = Number(process.env.SETUP_HUB_PORT || 8095);
const API = 'http://127.0.0.1:' + (process.env.PAYMENT_API_PORT || 6100);
const PAGE = path.join(__dirname, 'hub.html');

// `pub` names the .env variable holding the service's public (tunnel) URL, if any.
const SERVICES = [
  { key: 'store', name: 'Demo Store', port: 5000, path: '/health', pub: 'YOUPI_PUBLIC_STORE_URL' },
  { key: 'checkout', name: 'Checkout Portal', port: 7000, path: '/health', pub: 'CHECKOUT_PUBLIC_URL' },
  { key: 'api', name: 'Payment API', port: 6100, path: '/health', pub: 'YOUPI_PUBLIC_API_URL' },
  { key: 'admin', name: 'Merchant Admin', port: 6001, path: '/health', pub: 'YOUPI_PUBLIC_ADMIN_URL' },
  { key: 'sms', name: 'SMS Observer', port: 6002, path: '/health' },
  { key: 'gmail', name: 'Gmail Observer', port: 6003, path: '/health' },
  { key: 'control', name: 'Control Center', port: 8090, path: '/' }
];

const publicUrl = (name) => (name && process.env[name] ? process.env[name].replace(/\/+$/, '') : null);

function lanIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) return a.address;
    }
  }
  return null;
}

async function probe(url, timeoutMs = 3000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    // AirPlay Receiver answers 403 with a Server: AirTunes header on ports 5000/7000.
    const airplay = /airtunes/i.test(res.headers.get('server') || '');
    return { ok: res.status < 500 && !airplay, status: res.status, airplay };
  } catch {
    return { ok: false, status: 0, airplay: false };
  }
}

async function admin(pathname, { method = 'GET', body } = {}) {
  const res = await fetch(API + '/api/v1/admin/' + pathname, {
    method,
    headers: { Authorization: 'Bearer ' + getAdminToken(), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000)
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) throw Object.assign(new Error(data.error || data.message || 'HTTP ' + res.status), { status: res.status });
  return data;
}

const safe = (p) => p.catch((err) => ({ error: err.message }));

async function buildState() {
  const ip = lanIp();
  const services = await Promise.all(SERVICES.map(async (s) => {
    const local = await probe(`http://127.0.0.1:${s.port}${s.path}`);
    const pub = publicUrl(s.pub);
    // Tunnels add DNS and edge latency, so give them longer than local ports.
    const pubReach = pub ? await probe(pub + s.path, 10000) : null;
    return { ...s, local, pubReach, url: `http://127.0.0.1:${s.port}`, publicUrl: pub };
  }));

  const [upi, whatsapp, observers, gmail, merchant] = await Promise.all([
    safe(admin('upi-accounts')),
    safe(admin('whatsapp/status')),
    safe(admin('observers')),
    safe(admin('gmail/credentials')),
    safe(admin('merchant-settings'))
  ]);

  const g = gmail.gmailConfig || {};
  return {
    lanIp: ip,
    envApiUrl: process.env.BASE_PAYMENT_API_URL || null,
    services,
    upi: { accounts: upi.accounts || [], error: upi.error },
    whatsapp: {
      status: whatsapp.status || 'UNKNOWN',
      connected: Boolean(whatsapp.isConnected),
      phoneNumber: whatsapp.phoneNumber || null,
      pairingCode: whatsapp.pairingCode || null,
      error: whatsapp.error
    },
    android: { devices: observers.android?.devices || [], error: observers.error },
    sms: observers.sms || null,
    gmail: {
      hasClientId: Boolean(g.clientId),
      hasClientSecret: Boolean(g.hasClientSecret),
      connectedEmail: g.connectedEmail || null,
      observer: observers.gmail || null,
      redirectUri: process.env.GMAIL_REDIRECT_URI || 'http://localhost:6003/oauth/callback',
      error: gmail.error
    },
    merchant: {
      businessName: merchant.businessName || null,
      webhookUrl: merchant.webhookUrl || null,
      publishableKey: merchant.publishableKey || null
    }
  };
}

// The gateway's own pairing QR says http://localhost:6100 in localhost mode, which a
// phone cannot reach. Re-issue the same pairing payload pointing at the public tunnel
// (or, without one, the LAN address).
async function androidPairing() {
  const ip = lanIp();
  const gw = publicUrl('YOUPI_PUBLIC_API_URL') || (ip && `http://${ip}:6100`);
  if (!gw) throw new Error('No public tunnel URL and no Wi-Fi address for the phone to reach.');
  const src = await admin('sms-gateway/pair-qr');
  const payload = JSON.parse(src.pairingPayload || JSON.stringify(src.payload));
  payload.serverUrl = payload.gatewayUrl = payload.apiBaseUrl = gw;
  const apkUrl = (publicUrl('YOUPI_PUBLIC_ADMIN_URL') || `http://${ip}:6001`) + '/youpi-sms-gateway.apk';
  return {
    gatewayUrl: gw,
    enrollmentToken: payload.enrollmentToken || payload.token,
    expiresAt: payload.expiresAt,
    pairingQrSvg: generateQrSvg(JSON.stringify(payload), 240),
    apkUrl,
    apkQrSvg: generateQrSvg(apkUrl, 200)
  };
}

function send(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); } });
  });
}

const routes = {
  'GET /api/state': () => buildState(),
  'GET /api/android/pairing': () => androidPairing(),
  'POST /api/upi': (b) => admin('upi-accounts', { method: 'POST', body: { upiId: b.upiId, payeeName: b.payeeName, isActive: true } }),
  'POST /api/whatsapp/connect': () => admin('whatsapp/reconnect', { method: 'POST', body: {} }),
  'GET /api/whatsapp/qr': () => admin('whatsapp/qr'),
  'POST /api/whatsapp/pairing-code': (b) => admin('whatsapp/pairing-code', { method: 'POST', body: { phoneNumber: b.phoneNumber } }),
  'POST /api/whatsapp/disconnect': () => admin('whatsapp/disconnect', { method: 'POST', body: {} }),
  'POST /api/whatsapp/test': (b) => admin('whatsapp/test-message', { method: 'POST', body: { to: b.to, message: b.message } }),
  'POST /api/gmail/credentials': (b) => admin('gmail/credentials', { method: 'POST', body: { clientId: b.clientId, clientSecret: b.clientSecret } }),
  'GET /api/gmail/oauth': () => admin('gmail/oauth/start')
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/health') return send(res, 200, { status: 'UP', service: 'setup-hub' });
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(fs.readFileSync(PAGE));
  }
  const handler = routes[`${req.method} ${url.pathname}`];
  if (!handler) return send(res, 404, { error: 'Not found' });
  // Same-origin only: refuse cross-site writes from other pages in the browser.
  const origin = req.headers.origin;
  if (req.method !== 'GET' && origin && !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin)) {
    return send(res, 403, { error: 'Forbidden origin' });
  }
  try {
    send(res, 200, await handler(req.method === 'POST' ? await readBody(req) : {}));
  } catch (err) {
    send(res, err.status && err.status < 500 ? err.status : 502, { error: err.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[Setup Hub] http://127.0.0.1:${PORT}`);
});
