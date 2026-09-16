import {
  Limits,
  isRequestIdValid,
  normalizeText,
  validateReview,
  validateFiles,
  tooManyFields,
  isSafeImageUrl,
  validateCatalogPayload,
} from './validators';

interface Env {
  BOT_TOKEN: string;
  CHAT_ID: string;
  CATALOG_KV: KVNamespace;
  /** Set to enable Turnstile verification. When absent, Turnstile is skipped (graceful degradation). */
  TURNSTILE_SECRET?: string;
}

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
async function parseJsonObject(request: Request, maxBytes: number = Limits.maxJsonBytes): Promise<
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

// ── Allowed origins (supplementary layer, NOT auth) ──
const ALLOWED_ORIGINS = [
  'https://rudrymor.github.io',
  'http://localhost:8080',
  'http://127.0.0.1:8080',
];

/** Check if Origin header matches allowed list. Returns null if OK, or error Response. */
function checkOrigin(request: Request): Response | null {
  const origin = request.headers.get('origin');
  if (!origin) return null; // Allow non-browser clients (curl, server-to-server)
  if (ALLOWED_ORIGINS.some(o => origin.startsWith(o))) return null;
  return json({ error: 'Origin not allowed' }, 403);
}

function clientIp(request: Request): string {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}

function sanitizeIp(ip: string): string {
  const parts = ip.split('.');
  if (parts.length === 4) return parts[0] + '.' + parts[1] + '.' + parts[2] + '.x';
  return ip.length > 8 ? ip.slice(0, 8) + '…' : ip;
}

// ── Rate limit (KV-based, per-IP window) ──
const RATE_WINDOW_SEC = 3600; // 1 hour
const RATE_ORDER_MAX = 5;     // max orders per IP per hour
const RATE_REVIEW_MAX = 3;    // max reviews per IP per hour
const RATE_KV_TTL = RATE_WINDOW_SEC + 3600; // keep key for ~2h

/**
 * KV-based sliding-window rate limit. Returns null if under limit, or a 429 Response.
 * Uses a per-IP hour-bucket key with a TTL. Not atomic (KV eventual consistency) but
 * a reasonable abuse-control layer on top of the browser limits.
 */
async function enforceRateLimit(request: Request, env: Env, kind: 'order' | 'review'): Promise<Response | null> {
  const ip = clientIp(request);
  const bucket = Math.floor(Date.now() / (RATE_WINDOW_SEC * 1000));
  const key = `rl:${kind}:${ip}:${bucket}`;
  const max = kind === 'order' ? RATE_ORDER_MAX : RATE_REVIEW_MAX;

  try {
    const raw = await env.CATALOG_KV.get(key);
    const count = raw ? parseInt(raw, 10) : 0;
    if (count >= max) {
      log('warn', 'rate-limit exceeded', { kind, ip: sanitizeIp(ip), bucket, count, max });
      return json({ error: 'Слишком много запросов. Подождите час.' }, 429);
    }
    await env.CATALOG_KV.put(key, String(count + 1), { expirationTtl: RATE_KV_TTL });
    return null;
  } catch (err) {
    // Never fail the request because rate limiting broke.
    log('error', 'rate-limit KV error', { kind, error: String(err) });
    return null;
  }
}

// ── Turnstile (optional; skip when TURNSTILE_SECRET not set) ──
async function enforceTurnstile(request: Request, env: Env, token?: unknown): Promise<Response | null> {
  if (!env.TURNSTILE_SECRET) {
    return null; // Not configured yet — graceful degradation.
  }
  const t = String(token || '').trim();
  if (!t) {
    return json({ error: 'Missing Turnstile token' }, 403);
  }
  try {
    const form = new URLSearchParams();
    form.set('secret', env.TURNSTILE_SECRET);
    form.set('response', t);
    form.set('remoteip', clientIp(request));
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: form,
    });
    const data = (await res.json()) as { success?: boolean; 'error-codes'?: string[] };
    if (!data.success) {
      log('warn', 'turnstile verification failed', { codes: data['error-codes'] });
      return json({ error: 'Turnstile verification failed' }, 403);
    }
    return null;
  } catch (err) {
    log('error', 'turnstile siteverify error', { error: String(err) });
    return json({ error: 'Turnstile service unavailable' }, 502);
  }
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
// ПРИМЕЧАНИЕ (Этап 3): текущая схема check→send→put неатомарна. Полная атомарность —
// через Durable Object в этапе 3. Здесь request_id уже обязательный (валидируется ниже),
// а повтор с тем же ID возвращает сохранённый результат.
async function checkIdempotency(env: Env, requestId: string): Promise<{ exists: boolean; result?: Record<string, unknown> }> {
  const raw = await env.CATALOG_KV.get(`idem:${requestId}`, 'json');
  if (!raw) return { exists: false };
  return { exists: true, result: raw as Record<string, unknown> };
}

async function storeIdempotency(env: Env, requestId: string, result: Record<string, unknown>): Promise<void> {
  try {
    await env.CATALOG_KV.put(`idem:${requestId}`, JSON.stringify(result), { expirationTtl: Limits.idempotencyTtl });
  } catch (err) {
    log('warn', 'KV write failed for idempotency', { requestId, error: String(err) });
  }
}

// ── Telegram ──
type TelegramResult = { ok: boolean; description?: string };

async function sendMessage(env: Env, text: string): Promise<TelegramResult> {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: env.CHAT_ID, text }),
  });
  return (await res.json()) as TelegramResult;
}

type SendDocumentResult =
  | { ok: true }
  | { ok: false; description?: string }
  | { ok: false; error: string; kind: 'network' | 'parse' };

async function sendDocument(env: Env, file: File, name: string): Promise<SendDocumentResult> {
  const fd = new FormData();
  fd.append('chat_id', env.CHAT_ID);
  fd.append('document', file, name || 'file');
  let res: Response;
  try {
    res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendDocument`, { method: 'POST', body: fd });
  } catch (err) {
    return { ok: false, error: String(err), kind: 'network' };
  }
  if (!res.ok) {
    return { ok: false, description: `HTTP ${res.status}` };
  }
  let data: { ok?: boolean; description?: string } = {};
  try {
    data = (await res.json()) as { ok?: boolean; description?: string };
  } catch (err) {
    return { ok: false, error: String(err), kind: 'parse' };
  }
  return { ok: data.ok === true, description: data.description };
}

// ── Catalog API ──
const CATALOG_KEY = 'catalog';

async function getCatalog(env: Env): Promise<Response> {
  const raw = await env.CATALOG_KV.get(CATALOG_KEY);
  if (!raw) {
    return json({ items: [], updated: null }, 200);
  }
  try {
    const data = JSON.parse(raw);
    const v = validateCatalogPayload(data);
    if (!v.ok) {
      log('error', 'catalog validation failed', { error: v.error });
      return json({ error: 'Invalid catalog data' }, 500);
    }
    return json({ items: v.items }, 200, { 'Cache-Control': 'public, max-age=60' });
  } catch {
    log('error', 'catalog JSON parse failed');
    return json({ error: 'Invalid KV data' }, 500);
  }
}

// ── Shared: обязательный request_id ──
/** Возвращает нормализованный request_id или ошибку-Response. */
function validateRequestIdResponse(value: unknown): { ok: true; id: string } | { ok: false; response: Response } {
  if (!isRequestIdValid(value)) {
    return { ok: false, response: json({ error: 'request_id is required and must be a valid UUID v4' }, 400) };
  }
  // isRequestIdValid гарантирует string
  return { ok: true, id: value as string };
}

/**
 * Общий путь для honeypot: true → «тихий» успех (не раскрываем боту, что поймали).
 */
function isHoneypot(v: unknown): boolean {
  return !!(v && String(v).trim());
}

// ── Order handler ──
async function handleOrder(request: Request, env: Env): Promise<Response> {
  const requestId = crypto.randomUUID();
  log('info', 'order: incoming', { requestId });

  const originErr = checkOrigin(request);
  if (originErr) return originErr;

  const rateErr = await enforceRateLimit(request, env, 'order');
  if (rateErr) return rateErr;

  const contentType = request.headers.get('content-type') || '';

  // ── JSON path (no files) ──
  if (!contentType.includes('multipart/form-data')) {
    const parsed = await parseJsonObject(request);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;

    // Turnstile
    const tsErr = await enforceTurnstile(request, env, body['cf-turnstile-response']);
    if (tsErr) return tsErr;

    // Honeypot
    if (isHoneypot(body.honeypot)) {
      log('info', 'order: honeypot triggered', { requestId });
      return json({ ok: true, silent: true }, 200);
    }

    // request_id — обязательный UUID v4
    const rid = validateRequestIdResponse(body.request_id);
    if (!rid.ok) return rid.response;

    const text = normalizeText(body.text);
    if (text.length < Limits.textMin) {
      return json({ error: `Text too short (min ${Limits.textMin} characters)` }, 400);
    }

    // Idempotency
    const idem = await checkIdempotency(env, rid.id);
    if (idem.exists) return json(idem.result!, 200);

    const orderNum = getNextOrderNumber();
    const now = new Date();
    const dateStr = now.toLocaleDateString('ru-RU') + ' ' + now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    const fullText = '🆕 Заявка #' + orderNum + '\n📅 ' + dateStr + '\n\n' + text;

    const res = await sendMessage(env, fullText);
    const result = { ok: res.ok, order: orderNum, description: res.description };

    await storeIdempotency(env, rid.id, result);
    log(res.ok ? 'info' : 'error', 'order: telegram result', { requestId, order: orderNum, ok: res.ok });
    return json(result, res.ok ? 200 : 502);
  }

  // ── Multipart path (with files) ──
  // Check Content-Length before formData() to prevent oversized multipart.
  const cl = request.headers.get('content-length');
  if (cl && parseInt(cl, 10) > Limits.maxMultipartBytes) {
    return json({ error: 'Request body too large' }, 413);
  }

  const form = await request.formData();

  // Limit number of fields (SEC-04) — защита от абуза служебными полями.
  if (tooManyFields([...form.keys()].length)) {
    return json({ error: 'Too many fields' }, 413);
  }

  // Turnstile
  const tsErr = await enforceTurnstile(request, env, form.get('cf-turnstile-response'));
  if (tsErr) return tsErr;

  // Honeypot
  const honeypot = form.get('honeypot');
  if (isHoneypot(honeypot)) {
    log('info', 'order: honeypot triggered (multipart)', { requestId });
    return json({ ok: true, silent: true }, 200);
  }

  // request_id — обязательный UUID v4
  const rid = validateRequestIdResponse(form.get('request_id'));
  if (!rid.ok) return rid.response;

  const text = normalizeText(form.get('text'));
  if (text.length < Limits.textMin) {
    return json({ error: `Text too short (min ${Limits.textMin} characters)` }, 400);
  }

  // Idempotency (перед отправкой)
  const idem = await checkIdempotency(env, rid.id);
  if (idem.exists) return json(idem.result!, 200);

  // Files validation (расширение/MIME/размер/количество)
  const files = form.getAll('files').filter((v): v is File => v instanceof File);
  const filesV = validateFiles(files);
  if (!filesV.ok) return json({ error: filesV.error }, filesV.status);
  const fileList: File[] = files.filter(f => f.size > 0);

  const orderNum = getNextOrderNumber();
  const now = new Date();
  const dateStr = now.toLocaleDateString('ru-RU') + ' ' + now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const fullText = '🆕 Заявка #' + orderNum + '\n📅 ' + dateStr + '\n\n' + text;

  const msgRes = await sendMessage(env, fullText);
  if (!msgRes.ok) {
    const result = { ok: false, order: orderNum, description: msgRes.description };
    await storeIdempotency(env, rid.id, result);
    log('error', 'order: telegram sendMessage failed', { requestId, order: orderNum, desc: msgRes.description });
    return json(result, 502);
  }

  let sent = 0;
  for (let i = 0; i < fileList.length; i++) {
    const name = filesV.fileNames[i].name;
    const docRes = await sendDocument(env, fileList[i], name);
    if (!docRes.ok) {
      const result = {
        ok: false, status: 'partial', order: orderNum,
        sent, total: fileList.length,
        message: 'Text sent but file delivery failed. Contact VK for file resend.',
      };
      await storeIdempotency(env, rid.id, result);
      log('warn', 'order: partial file failure', { requestId, order: orderNum, sent, total: fileList.length });
      return json(result, 200);
    }
    sent++;
  }

  const result = { ok: true, status: 'success', order: orderNum, files: sent };
  await storeIdempotency(env, rid.id, result);
  log('info', 'order: complete', { requestId, order: orderNum, files: sent });
  return json(result, 200);
}

// ── Review handler ──
async function handleReview(request: Request, env: Env): Promise<Response> {
  const requestId = crypto.randomUUID();
  log('info', 'review: incoming', { requestId });

  const originErr = checkOrigin(request);
  if (originErr) return originErr;

  const rateErr = await enforceRateLimit(request, env, 'review');
  if (rateErr) return rateErr;

  const parsed = await parseJsonObject(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  // Turnstile
  const tsErr = await enforceTurnstile(request, env, body['cf-turnstile-response']);
  if (tsErr) return tsErr;

  // Honeypot
  if (isHoneypot(body.honeypot)) {
    log('info', 'review: honeypot triggered', { requestId });
    return json({ ok: true, silent: true }, 200);
  }

  // request_id — обязательный UUID v4
  const rid = validateRequestIdResponse(body.request_id);
  if (!rid.ok) return rid.response;

  // Валидация содержимого отзыва
  const v = validateReview(body);
  if (!v.ok) return json({ error: v.error.message }, v.error.status);

  const idem = await checkIdempotency(env, rid.id);
  if (idem.exists) return json(idem.result!, 200);

  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const stars = '⭐'.repeat(v.data.rating);
  const fullText = `📝 Отзыв\n\n${esc(v.data.name)} (${stars})\n\n${esc(v.data.text)}`;

  const res = await sendMessage(env, fullText);
  const result = { ok: res.ok, description: res.description };
  await storeIdempotency(env, rid.id, result);
  log(res.ok ? 'info' : 'error', 'review: telegram result', { requestId, ok: res.ok });
  return json(result, res.ok ? 200 : 502);
}

// ── Router ──
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

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

    // Unknown routes → 404
    return json({ error: 'Not found' }, 404);
  },
};