import {
  Limits,
  isRequestIdValid,
  normalizeText,
  validateReview,
  validateOrder,
  validateFiles,
  tooManyFields,
  validateCatalogPayload,
  type OrderInput,
} from './validators';
import { claimIdempotency, finalizeIdempotency } from './idempotency';
// Durable Object для атомарной idempotency — re-export, чтобы wrangler
// нашёл класс в этом модуле (см. [[migrations]] в wrangler.toml).
export { IdempotencyObject } from './idempotency';

interface Env {
  BOT_TOKEN: string;
  CHAT_ID: string;
  CATALOG_KV: KVNamespace;
  IDEMPOTENCY: DurableObjectNamespace;
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
      return json({ ok: false, status: 'ratelimited', error: 'Слишком много запросов. Подождите час.' }, 429);
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
/**
 * Легаси-путь: старый клиент (до деплоя Pages на этапе 10) слал готовую строку
 * `text`. Пока новый клиент не в проде, Worker принимает оба контракта.
 * После деплоя Pages поставить false и удалить ветку (см. ревью, этап 10).
 */
const ALLOW_LEGACY_TEXT = true;

/** Собирает служебный текст заявки для Telegram из ПРОВЕРЕННЫХ полей. */
function buildOrderText(
  orderNum: string,
  dateStr: string,
  o: OrderInput,
  fileNames: string[],
  filesTotal: number,
): string {
  const lines = [
    '🆕 Заявка #' + orderNum,
    '📅 ' + dateStr,
    '',
    '👤 Имя: ' + o.name,
    '📱 Контакт: ' + o.contact,
    '📦 Материал: ' + (o.material || 'Не указан'),
    '🎨 Цвет: ' + (o.color || 'Не указан'),
    '🔢 Копий: ' + o.quantity,
    '📎 Файлы: ' + (fileNames.length ? fileNames.join(', ') + ' (' + filesTotal + ')' : 'нет'),
  ];
  // Свободный текст — последним блоком и с префиксом «│ »: даже если внутри
  // описания есть строка вида «📦 Материал: …», она визуально остаётся внутри
  // блока описания, а не выглядит отдельным полем заявки.
  if (o.description) {
    lines.push('', '📝 Описание:');
    o.description.split('\n').forEach(line => lines.push(line ? '│ ' + line : '│'));
  }
  return lines.join('\n');
}

function formatOrderDate(now: Date): string {
  return (
    now.toLocaleDateString('ru-RU') +
    ' ' +
    now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
  );
}

async function handleOrder(request: Request, env: Env): Promise<Response> {
  const requestId = crypto.randomUUID();
  log('info', 'order: incoming', { requestId });

  const originErr = checkOrigin(request);
  if (originErr) return originErr;

  const rateErr = await enforceRateLimit(request, env, 'order');
  if (rateErr) return rateErr;

  const contentType = request.headers.get('content-type') || '';
  const isMultipart = contentType.includes('multipart/form-data');

  // ── Читаем вход: multipart (с файлами) или JSON (без файлов) ──
  let get: (key: string) => unknown;
  let files: File[] = [];

  if (isMultipart) {
    // Content-Length проверяем ДО formData(), чтобы не парсить гигантский body.
    const cl = request.headers.get('content-length');
    if (cl && parseInt(cl, 10) > Limits.maxMultipartBytes) {
      return json({ ok: false, status: 'invalid', error: 'Request body too large' }, 413);
    }
    const form = await request.formData();
    if (tooManyFields([...form.keys()].length)) {
      return json({ ok: false, status: 'invalid', error: 'Too many fields' }, 413);
    }
    get = (key: string) => form.get(key);
    files = form.getAll('files').filter((v): v is File => v instanceof File);
  } else {
    const parsed = await parseJsonObject(request);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    get = (key: string) => body[key];
  }

  // Turnstile (если настроен secret; иначе — no-op)
  const tsErr = await enforceTurnstile(request, env, get('cf-turnstile-response'));
  if (tsErr) return tsErr;

  // Honeypot — «тихий» успех, ничего не отправляем и не раскрываем бота
  if (isHoneypot(get('honeypot'))) {
    log('info', 'order: honeypot triggered', { requestId, multipart: isMultipart });
    return json({ ok: true, status: 'success', silent: true }, 200);
  }

  // request_id — обязательный UUID v4
  const rid = validateRequestIdResponse(get('request_id'));
  if (!rid.ok) return rid.response;

  // Структурированные поля (BUG-01): текст для Telegram собирает сервер.
  const structured = validateOrder({
    name: get('name'),
    contact: get('contact'),
    description: get('description'),
    material: get('material'),
    color: get('color'),
    quantity: get('quantity'),
  });

  // Легаси-контракт (только пока в проде старый клиент): готовая строка `text`.
  const legacyText =
    ALLOW_LEGACY_TEXT && !structured.ok ? normalizeText(get('text')) : '';

  if (!structured.ok && legacyText.length < Limits.textMin) {
    log('warn', 'order: validation failed', { requestId, fields: Object.keys(structured.fields).join(',') });
    return json(
      { ok: false, status: 'invalid', error: 'Проверьте поля формы', fields: structured.fields },
      400,
    );
  }
  if (!structured.ok) {
    log('warn', 'order: legacy text payload accepted', { requestId });
  }

  // ── Валидация файлов ДО claim: иначе отклонённый файл «съедает» request_id
  // и повторная отправка после исправления получала бы 409. ──
  let fileNames: string[] = [];
  if (isMultipart) {
    const filesV = validateFiles(files);
    if (!filesV.ok) {
      log('warn', 'order: files rejected', { requestId, status: filesV.status });
      return json({ ok: false, status: 'invalid', error: filesV.error }, filesV.status);
    }
    // Имена берём из валидированного списка, пустые файлы отбрасываем:
    // fileNames[i] соответствует files[i] после фильтра.
    fileNames = filesV.fileNames.map(f => f.name);
    files = files.filter(f => f.size > 0);
  }

  // ── Idempotency: атомарный claim через Durable Object (этап 3) ──
  // Первый запрос занимает ключ и шлёт; параллельный дубликат того же ID
  // получает 409 и НЕ шлёт; repeat с завершённым ID возвращает прежний ответ.
  const claim = await claimIdempotency(env.IDEMPOTENCY, rid.id, Limits.idempotencyTtl);
  if (!claim.ok) {
    // 409 = в обработке параллельным, 200 + result = replay (уже завершено).
    return json(
      claim.result ?? { ok: false, status: 'pending', error: 'Заявка уже обрабатывается. Подождите.' },
      claim.status,
    );
  }

  const orderNum = getNextOrderNumber();
  const dateStr = formatOrderDate(new Date());
  const fullText = structured.ok
    ? buildOrderText(orderNum, dateStr, structured.data, fileNames, files.length)
    : '🆕 Заявка #' + orderNum + '\n📅 ' + dateStr + '\n\n' + legacyText;

  // ── Отправка в Telegram ──
  let msgRes: TelegramResult;
  try {
    msgRes = await sendMessage(env, fullText);
  } catch (err) {
    // Результат upstream неизвестен. Автоматически НЕ повторяем: сообщение
    // могло уйти. Фиксируем терминальное состояние, чтобы ретрай с тем же
    // request_id не создал дубль, и честно говорим об этом пользователю.
    const result = {
      ok: false,
      status: 'unknown',
      order: orderNum,
      message: 'Ответ Telegram не получен. Заявка может быть доставлена — не отправляйте её повторно, свяжитесь через ВКонтакте.',
    };
    await finalizeIdempotency(env.IDEMPOTENCY, rid.id, result, Limits.idempotencyTtl);
    log('error', 'order: telegram send unknown', { requestId, order: orderNum, error: String(err) });
    return json(result, 502);
  }

  if (!msgRes.ok) {
    const result = {
      ok: false,
      status: 'rejected',
      order: orderNum,
      description: msgRes.description,
      message: 'Telegram отклонил заявку. Попробуйте ещё раз или свяжитесь через ВКонтакте.',
    };
    await finalizeIdempotency(env.IDEMPOTENCY, rid.id, result, Limits.idempotencyTtl);
    log('error', 'order: telegram sendMessage failed', { requestId, order: orderNum, desc: msgRes.description });
    return json(result, 502);
  }

  let sent = 0;
  for (let i = 0; i < files.length; i++) {
    const docRes = await sendDocument(env, files[i], fileNames[i]);
    if (!docRes.ok) {
      const result = {
        ok: false,
        status: 'partial',
        order: orderNum,
        sent,
        total: files.length,
        message: `Текст заявки отправлен, файлы — нет (доставлено ${sent} из ${files.length}). Пришлите файлы во ВКонтакте.`,
      };
      await finalizeIdempotency(env.IDEMPOTENCY, rid.id, result, Limits.idempotencyTtl);
      log('warn', 'order: partial file failure', { requestId, order: orderNum, sent, total: files.length });
      return json(result, 200);
    }
    sent++;
  }

  const result = { ok: true, status: 'success', order: orderNum, files: sent, total: files.length };
  await finalizeIdempotency(env.IDEMPOTENCY, rid.id, result, Limits.idempotencyTtl);
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
    return json({ ok: true, status: 'success', silent: true }, 200);
  }

  // request_id — обязательный UUID v4
  const rid = validateRequestIdResponse(body.request_id);
  if (!rid.ok) return rid.response;

  // Валидация содержимого отзыва: ошибки — картой по полям (как в order).
  const v = validateReview(body);
  if (!v.ok) {
    log('warn', 'review: validation failed', {
      requestId,
      fields: Object.keys(v.error.fields || {}).join(','),
    });
    return json(
      { ok: false, status: 'invalid', error: v.error.message, fields: v.error.fields },
      v.error.status,
    );
  }

  // Idempotency — атомарный claim через Durable Object (этап 3).
  const claim = await claimIdempotency(env.IDEMPOTENCY, rid.id, Limits.idempotencyTtl);
  if (!claim.ok) {
    // 409 = в обработке параллельным, 200 + result = replay (уже завершено).
    return json(
      claim.result ?? { ok: false, status: 'pending', error: 'Отзыв уже обрабатывается. Подождите.' },
      claim.status,
    );
  }

  // Текст уходит в Telegram КАК ЕСТЬ: sendMessage вызывается без parse_mode,
  // поэтому HTML не разбирается и экранирование не нужно (иначе в чате видны
  // буквальные «&amp;»). Поведение совпадает с handleOrder (UX-04).
  const stars = '⭐'.repeat(v.data.rating);
  const fullText = `📝 Отзыв\n\n${v.data.name} (${stars})\n\n${v.data.text}`;

  let res: TelegramResult;
  try {
    res = await sendMessage(env, fullText);
  } catch (err) {
    // Результат upstream неизвестен: автоматически не повторяем, фиксируем
    // терминальное состояние, чтобы ретрай с тем же request_id не дал дубль.
    const result = {
      ok: false,
      status: 'unknown',
      message: 'Ответ Telegram не получен. Отзыв может быть доставлен — не отправляйте его повторно.',
    };
    await finalizeIdempotency(env.IDEMPOTENCY, rid.id, result, Limits.idempotencyTtl);
    log('error', 'review: telegram send unknown', { requestId, error: String(err) });
    return json(result, 502);
  }

  if (!res.ok) {
    const result = {
      ok: false,
      status: 'rejected',
      description: res.description,
      message: 'Telegram отклонил отзыв. Попробуйте ещё раз или напишите во ВКонтакте.',
    };
    await finalizeIdempotency(env.IDEMPOTENCY, rid.id, result, Limits.idempotencyTtl);
    log('error', 'review: telegram rejected', { requestId, desc: res.description });
    return json(result, 502);
  }

  const result = { ok: true, status: 'success' };
  await finalizeIdempotency(env.IDEMPOTENCY, rid.id, result, Limits.idempotencyTtl);
  log('info', 'review: complete', { requestId });
  return json(result, 200);
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