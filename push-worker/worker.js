/* Repco Roster push relay - a free Cloudflare Worker (no npm, paste straight into the dashboard).
   The roster page calls POST /notify with the sender's Firebase login token. The worker reads
   each recipient's phone subscriptions from the database *using that token*, so the database
   rules decide who may send - people without a roster account get nothing.

   Settings (Worker -> Settings -> Variables and Secrets):
     DB_URL             https://repco-roster-default-rtdb.asia-southeast1.firebasedatabase.app
     VAPID_PUBLIC_KEY   the public key that is also in cloud.js
     VAPID_PRIVATE_KEY  the private key (add it as a *Secret*)
     VAPID_SUBJECT      mailto:you@example.com
     ALLOWED_ORIGIN     https://blackbeard9488.github.io  (optional, defaults to *)
*/

export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== '/notify') return new Response('Repco Roster push relay', { headers: cors });

    let body;
    try { body = await request.json(); } catch (e) { return json({ error: 'bad json' }, 400, cors); }
    const { idToken, targets, title, body: text, close } = body || {};
    if (!idToken || !Array.isArray(targets) || !targets.length || targets.length > 100) return json({ error: 'bad request' }, 400, cors);

    const db = env.DB_URL.replace(/\/$/, '');
    // close: true replaces the earlier alert with the same tag (used when a shift offer is withdrawn)
    const payload = JSON.stringify({ title: String(title || 'Repco Roster').slice(0, 80), body: String(text || '').slice(0, 300), close: !!close });
    let sent = 0, removed = 0, denied = 0;
    for (const t of targets) {
      if (!t || typeof t.uid !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(t.uid)) continue;
      const r = await fetch(`${db}/push/${t.uid}.json?auth=${encodeURIComponent(idToken)}`);
      if (r.status === 401 || r.status === 403) { denied++; continue; }
      const subs = (await r.json()) || {};
      for (const sid of Object.keys(subs)) {
        const sub = subs[sid];
        if (!sub || !sub.endpoint || !sub.keys) continue;
        const res = await sendWebPush(sub, JSON.stringify({ ...JSON.parse(payload), tag: t.tag || 'repco-roster' }), env);
        if (res.status === 404 || res.status === 410) {
          await fetch(`${db}/push/${t.uid}/${sid}.json?auth=${encodeURIComponent(idToken)}`, { method: 'DELETE' });
          removed++;
        } else if (res.ok) sent++;
      }
    }
    if (denied && !sent) return json({ error: 'not allowed' }, 403, cors);
    return json({ sent, removed }, 200, cors);
  }
};

function json(o, status, headers) { return new Response(JSON.stringify(o), { status, headers: { ...headers, 'Content-Type': 'application/json' } }); }

/* ---- Web Push (RFC 8291 aes128gcm + RFC 8292 VAPID) with plain WebCrypto ---- */
const enc = new TextEncoder();
function b64uToBytes(s) { s = s.replace(/-/g, '+').replace(/_/g, '/'); s += '='.repeat((4 - s.length % 4) % 4); const bin = atob(s); const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a; }
function bytesToB64u(b) { let s = ''; const a = new Uint8Array(b); for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function concat(...parts) { const n = parts.reduce((t, p) => t + p.length, 0); const out = new Uint8Array(n); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; }
async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}

async function vapidHeader(endpoint, env) {
  const aud = new URL(endpoint).origin;
  const header = bytesToB64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = bytesToB64u(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT || 'mailto:admin@example.com' })));
  const pub = b64uToBytes(env.VAPID_PUBLIC_KEY);
  const jwk = { kty: 'EC', crv: 'P-256', d: env.VAPID_PRIVATE_KEY, x: bytesToB64u(pub.slice(1, 33)), y: bytesToB64u(pub.slice(33, 65)), ext: true };
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(header + '.' + claims));
  return `vapid t=${header}.${claims}.${bytesToB64u(sig)}, k=${env.VAPID_PUBLIC_KEY}`;
}

async function encryptPayload(sub, plaintext) {
  const uaPublic = b64uToBytes(sub.keys.p256dh);
  const authSecret = b64uToBytes(sub.keys.auth);
  const local = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, local.privateKey, 256));
  const ikm = await hkdf(authSecret, shared, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, concat(enc.encode(plaintext), new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 0x10, 0]);  // record size 4096
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, cipher);
}

export async function sendWebPush(sub, plaintext, env) {
  const bodyBytes = await encryptPayload(sub, plaintext);
  return fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '86400',
      Urgency: 'high',
      Authorization: await vapidHeader(sub.endpoint, env)
    },
    body: bodyBytes
  });
}
