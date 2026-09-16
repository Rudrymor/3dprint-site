interface Env {
  BOT_TOKEN: string;
  CHAT_ID: string;
  CATALOG_KV: KVNamespace;
}

// ── Limits ──
const MAX_FILES = 5;
const MAX_FILE_SIZE = 15 * 1024 * 1024;  // 15 МБ на файл
const MAX_TOTAL_SIZE = 40 * 1024 * 1024;  // 40 МБ на всю заявку
const IDEMPOTENCY_TTL = 86400; // 24 hours in seconds
const MAX_JSON_BODY = 1024 * 1024; // 1 МБ max JSON body
const MAX_MULTIPART_BODY = 50 * 1024 * 1024; // 50 МБ max multipart (with overhead)
const MAX_FIELDS = 20; // max additional multipart fields
const MAX_FIELD_LEN = 10000; // max length for text fields

// ── Allowed origins (supplementary layer, NOT auth) ──
const ALLOWED_ORIGINS = [
  'https://rudrymor.github.io',
  'https://rudrymor.github.io',
  'http://localhost:8080',
  'http://127.0.0.1:8080',
];

// ── CORS ──
const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ── Structured logger ──
function log(level: 'info' | 'warn' | 'error', msg: string, meta: Record<string, unknown> = {}) {
  const entry = { level, msg, ts: new Date().toISOString(), ...meta };
  if (level === 'error') {
    console.error(JSON.stringify(entry));
  } else if (level === 'warn') {
    console.warn(JSON.stringify(entry));
  } else {
    console.log(JSON.stringify(entry));
  }
}

// ── Helpers ──
function json(data: unknown, status: number, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', ...extraHeaders },
  });
}

/**
 * Safely parse a JSON body. Returns the parsed object or an error response.
 * Rejects non-objects (null, arrays, strings, numbers).
 */
async function parseJsonObject(request: Request, maxBytes: number = MAX_JSON_BODY): Promise<
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; response: Response }
> {
  const cl = request.headers.get('content-length');
  if (cl && parseInt(cl, 10) > maxBytes) {
    return { ok: false, response: json({ error: 'Request body too large' }, 413) };
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return { ok: false, response: json({ error: 'Invalid JSON' }, 400) };
  }

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, response: json({ error: 'Request body must be a JSON object' }, 400) };
  }

  return { ok: true, body: raw as Record<string, unknown> };
}

/** Check if Origin header matches allowed list. Returns null if OK, or error Response. */
function checkOrigin(request: Request): Response | null {
  const origin = request.headers.get('origin');
  if (!origin) return null; // Allow non-browser clients (curl, server-to-server)
  if (ALLOWED_ORIGINS.some(o => origin.startsWith(o))) return null;
  return json({ error: 'Origin not allowed' }, 403);
}

// ── Order counter ──
function getNextOrderNumber(): string {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const random = Math.floor(1000 + Math.random() * 9000);
  return `${yy}${mm}${dd}-${random}`;
}

// ── Idempotency ──
async function checkIdempotency(env: Env, requestId: string): Promise<{ exists: boolean; result?: Record<string, unknown> }> {
  const raw = await env.CATALOG_KV.get(`idem:${requestId}`, 'json');
  if (!raw) return { exists: false };
  return { exists: true, result: raw as Record<string, unknown> };
}

async function storeIdempotency(env: Env, requestId: string, result: Record<string, unknown>): Promise<void> {
  try {
    await env.CATALOG_KV.put(`idem:${requestId}`, JSON.stringify(result), { expirationTtl: IDEMPOTENCY_TTL });
  } catch (err) {
    log('warn', 'KV write failed for idempotency', { requestId, error: String(err) });
  }
}

// ── Telegram ──
async function sendMessage(env: Env, text: string): Promise<{ ok: boolean; description?: string }> {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: env.CHAT_ID, text }),
  });
  return (await res.json()) as { ok: boolean; description?: string };
}

async function sendDocument(env: Env, file: File): Promise<{ ok: boolean; description?: string }> {
  const fd = new FormData();
  fd.append('chat_id', env.CHAT_ID);
  fd.append('document', file, file.name || 'file');
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendDocument`, { method: 'POST', body: fd });
  return (await res.json()) as { ok: boolean; description?: string };
}

// ── Catalog API ──
const CATALOG_KEY = 'catalog';

function isSafeImageUrl(url: string): boolean {
  if (!url || typeof url !== 'string') return false;
  if (/^(https?:|javascript:|data:|\/\/)/i.test(url)) return false;
  if (!url.startsWith('images/')) return false;
  if (url.includes('..')) return false;
  if (url.length > 200) return false;
  if (!/^images\/[a-zA-Z0-9_\-./]+\.(jpg|jpeg|png|gif|webp|svg)$/i.test(url)) return false;
  return true;
}

async function getCatalog(env: Env): Promise<Response> {
  const raw = await env.CATALOG_KV.get(CATALOG_KEY);
  if (!raw) {
    return json({ items: [], updated: null }, 200);
  }
  try {
    const data = JSON.parse(raw);
    return json(data, 200, { 'Cache-Control': 'public, max-age=60' });
  } catch {
    return json({ error: 'Invalid KV data' }, 500);
  }
}

// ── Order handler ──
async function handleOrder(request: Request, env: Env): Promise<Response> {
  const requestId = crypto.randomUUID();
  log('info', 'order: incoming', { requestId });

  const originErr = checkOrigin(request);
  if (originErr) return originErr;

  const contentType = request.headers.get('content-type') || '';

  // ── JSON path ──
  if (!contentType.includes('multipart/form-data')) {
    const parsed = await parseJsonObject(request);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;

    // Honeypot
    if (body.honeypot) {
      log('info', 'order: honeypot triggered', { requestId });
      return json({ ok: true, silent: true }, 200);
    }

    const text = String(body.text || '').substring(0, MAX_FIELD_LEN);
    if (text.trim().length < 10) {
      return json({ error: 'Text too short (min 10 characters)' }, 400);
    }

    // Idempotency
    const idemKey = String(body.request_id || '');
    if (idemKey) {
      if (idemKey.length > 200) {
        return json({ error: 'request_id too long' }, 400);
      }
      const idem = await checkIdempotency(env, idemKey);
      if (idem.exists) return json(idem.result!, 200);
    }

    const orderNum = getNextOrderNumber();
    const now = new Date();
    const dateStr = now.toLocaleDateString('ru-RU') + ' ' + now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    const fullText = '🆕 Заявка #' + orderNum + '\n📅 ' + dateStr + '\n\n' + text;

    const res = await sendMessage(env, fullText);
    const result = { ok: res.ok, order: orderNum, description: res.description };

    if (idemKey) await storeIdempotency(env, idemKey, result);
    log(res.ok ? 'info' : 'error', 'order: telegram result', { requestId, order: orderNum, ok: res.ok });
    return json(result, res.ok ? 200 : 502);
  }

  // ── Multipart path ──
  // Check Content-Length before formData() to prevent oversized multipart
  const cl = request.headers.get('content-length');
  if (cl && parseInt(cl, 10) > MAX_MULTIPART_BODY) {
    return json({ error: 'Request body too large' }, 413);
  }

  const form = await request.formData();

  // Honeypot
  const honeypot = form.get('honeypot');
  if (honeypot) {
    log('info', 'order: honeypot triggered (multipart)', { requestId });
    return json({ ok: true, silent: true }, 200);
  }

  const text = String(form.get('text') || '').substring(0, MAX_FIELD_LEN);
  if (text.trim().length < 10) {
    return json({ error: 'Text too short (min 10 characters)' }, 400);
  }

  // Idempotency
  const idemKey = String(form.get('request_id') || '');
  if (idemKey) {
    if (idemKey.length > 200) {
      return json({ error: 'request_id too long' }, 400);
    }
    const idem = await checkIdempotency(env, idemKey);
    if (idem.exists) return json(idem.result!, 200);
  }

  // Files validation
  const files = form.getAll('files').filter((v): v is File => v instanceof File && v.size > 0);
  if (files.length > MAX_FILES) return json({ error: `Too many files (max ${MAX_FILES})` }, 413);
  if (files.some(f => f.size > MAX_FILE_SIZE) || files.reduce((s, f) => s + f.size, 0) > MAX_TOTAL_SIZE) {
    return json({ error: 'Files too large' }, 413);
  }

  // Validate file types
  const ALLOWED_TYPES = [
    'image/jpeg', 'image/png', 'image/gif', 'image/webp',
    'application/pdf', 'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/plain',
  ];
  for (const file of files) {
    if (file.type && !ALLOWED_TYPES.includes(file.type)) {
      return json({ error: `Disallowed file type: ${file.type}` }, 415);
    }
  }

  const orderNum = getNextOrderNumber();
  const now = new Date();
  const dateStr = now.toLocaleDateString('ru-RU') + ' ' + now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const fullText = '🆕 Заявка #' + orderNum + '\n📅 ' + dateStr + '\n\n' + text;

  const msgRes = await sendMessage(env, fullText);
  if (!msgRes.ok) {
    const result = { ok: false, order: orderNum, description: msgRes.description };
    if (idemKey) await storeIdempotency(env, idemKey, result);
    log('error', 'order: telegram sendMessage failed', { requestId, order: orderNum, desc: msgRes.description });
    return json(result, 502);
  }

  let sent = 0;
  for (const file of files) {
    const docRes = await sendDocument(env, file);
    if (!docRes.ok) {
      const result = {
        ok: false, status: 'partial', order: orderNum,
        sent, total: files.length,
        message: 'Text sent but file delivery failed. Contact VK for file resend.',
      };
      if (idemKey) await storeIdempotency(env, idemKey, result);
      log('warn', 'order: partial file failure', { requestId, order: orderNum, sent, total: files.length });
      return json(result, 200);
    }
    sent++;
  }

  const result = { ok: true, status: 'success', order: orderNum, files: sent };
  if (idemKey) await storeIdempotency(env, idemKey, result);
  log('info', 'order: complete', { requestId, order: orderNum, files: sent });
  return json(result, 200);
}

// ── Review handler ──
async function handleReview(request: Request, env: Env): Promise<Response> {
  const requestId = crypto.randomUUID();
  log('info', 'review: incoming', { requestId });

  const originErr = checkOrigin(request);
  if (originErr) return originErr;

  const parsed = await parseJsonObject(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  // Honeypot
  if (body.honeypot) {
    log('info', 'review: honeypot triggered', { requestId });
    return json({ ok: true, silent: true }, 200);
  }

  if (!body.text || !body.name) {
    return json({ error: 'name and text required' }, 400);
  }

  const name = String(body.name).substring(0, 100);
  const text = String(body.text).substring(0, 2000);
  const rating = Math.min(5, Math.max(1, Number(body.rating) || 5));

  if (name.trim().length < 2) {
    return json({ error: 'Name too short' }, 400);
  }
  if (text.trim().length < 10) {
    return json({ error: 'Review too short (min 10 characters)' }, 400);
  }

  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const stars = '⭐'.repeat(rating);
  const fullText = `📝 Отзыв\n\n${esc(name)} (${stars})\n\n${esc(text)}`;

  const res = await sendMessage(env, fullText);
  log(res.ok ? 'info' : 'error', 'review: telegram result', { requestId, ok: res.ok });
  return json({ ok: res.ok, description: res.description }, res.ok ? 200 : 502);
}

// ── Router ──
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // ── Known routes ──

    // GET /api/catalog — public read only
    if (path === '/api/catalog') {
      if (request.method === 'GET') return getCatalog(env);
      return json({ error: 'Method not allowed' }, 405, { Allow: 'GET' });
    }

    // POST /api/order — protected form
    if (path === '/api/order') {
      if (request.method === 'POST') return handleOrder(request, env);
      return json({ error: 'Method not allowed' }, 405, { Allow: 'POST' });
    }

    // POST /api/review — protected form
    if (path === '/api/review') {
      if (request.method === 'POST') return handleReview(request, env);
      return json({ error: 'Method not allowed' }, 405, { Allow: 'POST' });
    }

    // ── Unknown routes → 404 ──
    return json({ error: 'Not found' }, 404);
  },
};

interface CatalogItem {
  id: number;
  name: string;
  description: string;
  image: string;
  category: string;
  material: string;
  price_s: string;
  price_m: string;
  price_l: string;
}
