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
     GEMINI_API_KEY     Google AI Studio key, as a *Secret* (for the roster photo check)
     GEMINI_MODEL       optional, defaults to gemini-flash-latest (Google's always-current Flash model)
     GITHUB_MODELS_TOKEN  GitHub token with "Models: read", as a *Secret* (first backup: GPT-4.1 via GitHub Models)
     GITHUB_MODEL       optional, defaults to openai/gpt-4.1
     AI                 Workers AI binding: last-resort reader (weaker, so its suggestions arrive unticked)
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
    if (request.method !== 'POST' || (url.pathname !== '/notify' && url.pathname !== '/scan')) return new Response('Repco Roster push relay', { headers: cors });

    let body;
    try { body = await request.json(); } catch (e) { return json({ error: 'bad json' }, 400, cors); }
    if (url.pathname === '/scan') return scanRoster(body, env, cors);
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

/* ---- Roster photo check: managers only; Gemini compares the photo with the roster ---- */
async function scanRoster(body, env, cors) {
  const { idToken, image, mime, roster } = body || {};
  if (!idToken || !image || !roster || !Array.isArray(roster.rows) || !Array.isArray(roster.dates)) return json({ error: 'bad request' }, 400, cors);
  if (!env.GEMINI_API_KEY && !env.GITHUB_MODELS_TOKEN && !env.AI) return json({ error: 'photo check is not set up' }, 501, cors);
  if (image.length > 14000000) return json({ error: 'photo is too large' }, 413, cors);
  // Only managers can read mgrdata, so the database rules decide who may use this
  const db = env.DB_URL.replace(/\/$/, '');
  const chk = await fetch(`${db}/mgrdata.json?shallow=true&auth=${encodeURIComponent(idToken)}`);
  if (!chk.ok) return json({ error: 'managers only' }, 403, cors);

  const table = roster.rows.map(r => `${r.name} | ` + r.shifts.map(v => v || 'OFF').join(' | ')).join('\n');
  const prompt = [
    'You are checking a PHOTO of a printed staff roster against the roster data below.',
    'Columns are days in this order: ' + roster.dates.join(' | ') + '.',
    'Each data row is: STAFF NAME | shift for each day (OFF means no shift, AB absent, UA unavailable).',
    '',
    table,
    '',
    'Look for cells in the photo that a person has changed by hand: a shift crossed out or marked with an X,',
    'a time written over or next to the printed one, or a handwritten shift in an empty cell.',
    'Also report any printed cell that clearly differs from the data.',
    'Only report cells you can actually see in the photo. Ignore any row or note mentioning Kate.',
    'For each change give: name (exactly as in the data), date (exactly as in the column list),',
    'photo: what the cell should now be ("OFF" if the shift is crossed out with nothing new written, otherwise the new time as HH:MM-HH:MM in 24-hour time),',
    'mark: "crossed", "written" or "different", and confidence from 0 to 1.',
    'Reply with JSON only: {"changes":[{"name":"","date":"","photo":"","mark":"","confidence":0}]}. If nothing is changed, reply {"changes":[]}.'
  ].join('\n');

  // Gemini first, then GPT-4.1 on GitHub Models, then Cloudflare's own model. All within Cloudflare's 100s limit.
  const tries = [];
  if (env.GEMINI_API_KEY) tries.push(['Gemini', () => askGemini(env, image, mime, prompt)]);
  if (env.GITHUB_MODELS_TOKEN) tries.push(['GPT-4.1 (GitHub)', () => askGitHubModels(env, image, mime, prompt)]);
  if (env.AI) tries.push(['Cloudflare AI', () => askWorkersAI(env, image, mime, prompt), true]);
  const failed = [];
  for (const [name, run, weak] of tries) {
    const res = await run();
    if (!res.error) return json({ changes: res.changes, service: name + (failed.length ? ' (backup - ' + failed.map(f => f.name + ' ' + f.why).join(', ') + ')' : ''), weak: !!weak }, 200, cors);
    failed.push({ name, why: res.why || 'failed', error: res.error });
  }
  return json({ error: failed.map(f => f.name + ': ' + f.error).join(' | ') }, 502, cors);
}

function parseChanges(raw) {
  const m = String(raw || '').replace(/```(json)?/g, '').match(/\{[\s\S]*\}/);
  const parsed = JSON.parse(m ? m[0] : raw);
  return Array.isArray(parsed.changes) ? parsed.changes.slice(0, 200) : [];
}

async function askGemini(env, image, mime, prompt) {
  const model = env.GEMINI_MODEL || 'gemini-flash-latest';
  const ask = (thinking) => {
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 45000);
    return fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST', signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{ parts: [{ inline_data: { mime_type: mime || 'image/jpeg', data: image } }, { text: prompt }] }],
        // Long "thinking" made answers take over 100 seconds, which Cloudflare cuts off (error 524)
        generationConfig: Object.assign({ temperature: 0, responseMimeType: 'application/json' }, thinking ? { thinkingConfig: { thinkingLevel: 'low' } } : {})
      })
    }).finally(() => clearTimeout(timer));
  };
  try {
    let r = await ask(true);
    let out = await r.json().catch(() => null);
    if (r.status === 400 && /think/i.test(JSON.stringify(out || ''))) { r = await ask(false); out = await r.json().catch(() => null); }
    if (!r.ok) { const msg = (out && out.error && out.error.message) || String(r.status); return { error: msg, why: r.status === 429 ? 'daily limit reached' : 'error ' + r.status }; }
    const content = (((out || {}).candidates || [])[0] || {}).content;
    const raw = content && content.parts ? content.parts.map(p => p.text || '').join('') : '';
    return { changes: parseChanges(raw) };
  } catch (e) {
    const slow = e && e.name === 'AbortError';
    return { error: slow ? 'took longer than 45 seconds' : String(e && e.message || e), why: slow ? 'too slow' : 'not reachable' };
  }
}

async function askGitHubModels(env, image, mime, prompt) {
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 30000);
  try {
    const r = await fetch('https://models.github.ai/inference/chat/completions', {
      method: 'POST', signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + env.GITHUB_MODELS_TOKEN, 'X-GitHub-Api-Version': '2022-11-28' },
      body: JSON.stringify({
        model: env.GITHUB_MODEL || 'openai/gpt-4.1', temperature: 0, max_tokens: 3000, response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: 'data:' + (mime || 'image/jpeg') + ';base64,' + image, detail: 'high' } }] }]
      })
    });
    const out = await r.json().catch(() => null);
    if (!r.ok) return { error: (out && out.error && (out.error.message || out.error.code)) || String(r.status), why: r.status === 429 ? 'daily limit reached' : 'error ' + r.status };
    return { changes: parseChanges(((out.choices || [])[0] || {}).message ? out.choices[0].message.content : '') };
  } catch (e) {
    const slow = e && e.name === 'AbortError';
    return { error: slow ? 'took longer than 30 seconds' : String(e && e.message || e), why: slow ? 'too slow' : 'not reachable' };
  } finally { clearTimeout(timer); }
}

async function askWorkersAI(env, image, mime, prompt) {
  try {
    const out = await env.AI.run(env.BACKUP_MODEL || '@cf/mistralai/mistral-small-3.1-24b-instruct', {
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: 'data:' + (mime || 'image/jpeg') + ';base64,' + image } }] }],
      max_tokens: 2048, temperature: 0
    });
    const raw = typeof out === 'string' ? out : (out && (out.response !== undefined ? (typeof out.response === 'string' ? out.response : JSON.stringify(out.response)) : JSON.stringify(out)));
    return { changes: parseChanges(raw) };
  } catch (e) { return { error: String(e && e.message || e) }; }
}

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
