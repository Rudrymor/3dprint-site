interface Env {
  BOT_TOKEN: string;
  CHAT_ID: string;
  CATALOG_KV: KVNamespace;
}
const MAX_FILES = 5;
const MAX_FILE_SIZE = 15 * 1024 * 1024;  // 15 МБ на файл (согласовано с клиентом)
const MAX_TOTAL_SIZE = 40 * 1024 * 1024;  // 40 МБ на всю заявку (согласовано с клиентом)
const IDEMPOTENCY_TTL = 86400; // 24 hours in seconds
const MAX_JSON_BODY = 1024 * 1024; // 1 МБ max JSON body

// ── CORS ──
const CORS_GET: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data: unknown, status: number, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_GET, 'Content-Type': 'application/json', ...extraHeaders },
  });
}

// ── Order counter ──
/**
 * Generate unique order number using timestamp + random.
 * Avoids non-atomic KV read-modify-write race condition.
 * Format: YYMMDD-XXXX where XXXX is random 4-digit suffix.
 */
function getNextOrderNumber(): string {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const random = Math.floor(1000 + Math.random() * 9000); // 1000-9999
  return `${yy}${mm}${dd}-${random}`;
}

// ── Idempotency ──
async function checkIdempotency(env: Env, requestId: string): Promise<{ exists: boolean; result?: { ok: boolean; order?: string; files?: number; error?: string } }> {
  const raw = await env.CATALOG_KV.get(`idem:${requestId}`, 'json');
  if (!raw) return { exists: false };
  return { exists: true, result: raw as { ok: boolean; order?: string; files?: number; error?: string } };
}

async function storeIdempotency(env: Env, requestId: string, result: { ok: boolean; order?: string; files?: number; error?: string }): Promise<void> {
  await env.CATALOG_KV.put(`idem:${requestId}`, JSON.stringify(result), { expirationTtl: IDEMPOTENCY_TTL });
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

// ── Catalog API ──
const CATALOG_KEY = 'catalog';

/**
 * Validate image URL — only relative paths starting with 'images/' are allowed.
 * Blocks absolute URLs (http://, https://), javascript:, data:, protocol-relative (//)
 * and any path traversal attempts (../).
 */
function isSafeImageUrl(url: string): boolean {
  if (!url || typeof url !== 'string') return false;
  // Must be a relative path
  if (/^(https?:|javascript:|data:|\/\/)/i.test(url)) return false;
  // Must start with images/
  if (!url.startsWith('images/')) return false;
  // No path traversal
  if (url.includes('..')) return false;
  // Reasonable length limit
  if (url.length > 200) return false;
  // Only safe characters
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

// ── Telegram proxy ──
async function handleTelegramProxy(request: Request, env: Env): Promise<Response> {
  try {
    const contentType = request.headers.get('content-type') || '';

    // JSON { text, honeypot, request_id }
    if (!contentType.includes('multipart/form-data')) {
      // Limit JSON body size
      const cl = request.headers.get('content-length');
      if (cl && parseInt(cl, 10) > MAX_JSON_BODY) {
        return json({ error: 'Request body too large' }, 413);
      }
      let body: { text?: string; honeypot?: string; request_id?: string };
      try {
        body = await request.json();
      } catch {
        return json({ error: 'Invalid JSON' }, 400);
      }

      // Honeypot check — bots fill hidden fields
      if (body.honeypot) {
        return json({ ok: true, silent: true }, 200);
      }

      if (!body.text) return json({ error: 'text required' }, 400);

      // Idempotency check
      if (body.request_id) {
        const idem = await checkIdempotency(env, body.request_id);
        if (idem.exists) return json(idem.result!, 200);
      }

      // Validate text length
      const text = String(body.text).substring(0, 4000);
      if (text.trim().length < 10) {
        return json({ error: 'Текст слишком короткий (минимум 10 символов)' }, 400);
      }

      // Increment order counter and prepend number to message
      const orderNum = getNextOrderNumber();
      const now = new Date();
      const dateStr = now.toLocaleDateString('ru-RU') + ' ' + now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
      const fullText = '🆕 Заявка #' + orderNum + '\n📅 ' + dateStr + '\n\n' + text;

      const res = await sendMessage(env, fullText);
      const result = { ok: res.ok, order: orderNum, description: res.description };

      // Store for idempotency
      if (body.request_id) {
        await storeIdempotency(env, body.request_id, result);
      }

      return json(result, res.ok ? 200 : 400);
    }

    // multipart/form-data
    const form = await request.formData();

    // Honeypot check
    const honeypot = form.get('honeypot');
    if (honeypot) {
      return json({ ok: true, silent: true }, 200);
    }

    const text = String(form.get('text') || '').substring(0, 4000);
    const requestId = String(form.get('request_id') || '');

    // Validate text length
    if (text.trim().length < 10) {
      return json({ error: 'Текст слишком короткий (минимум 10 символов)' }, 400);
    }

    // Idempotency check
    if (requestId) {
      const idem = await checkIdempotency(env, requestId);
      if (idem.exists) return json(idem.result!, 200);
    }

    const files = form.getAll('files').filter((v): v is File => v instanceof File && v.size > 0);

    if (files.length > MAX_FILES) return json({ error: `Не больше ${MAX_FILES} файлов` }, 413);
    if (files.some((f) => f.size > MAX_FILE_SIZE) || files.reduce((s, f) => s + f.size, 0) > MAX_TOTAL_SIZE) {
      return json({ error: 'Файлы слишком большие' }, 413);
    }

    // Validate file types (allow common document types)
    const ALLOWED_TYPES = [
      'image/jpeg', 'image/png', 'image/gif', 'image/webp',
      'application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/plain'
    ];
    for (const file of files) {
      if (file.type && !ALLOWED_TYPES.includes(file.type)) {
        return json({ error: `Недопустимый тип файла: ${file.type}` }, 415);
      }
    }

    // Increment order counter and prepend number to message
    const orderNum = getNextOrderNumber();
    const now = new Date();
    const dateStr = now.toLocaleDateString('ru-RU') + ' ' + now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    const fullText = '🆕 Заявка #' + orderNum + '\n📅 ' + dateStr + '\n\n' + text;

    if (fullText) {
      const res = await sendMessage(env, fullText);
      if (!res.ok) {
        const result = { ok: false, order: orderNum, description: res.description };
        if (requestId) await storeIdempotency(env, requestId, result);
        return json(result, 400);
      }
    }

    let sent = 0;
    for (const file of files) {
      const fd = new FormData();
      fd.append('chat_id', env.CHAT_ID);
      fd.append('document', file, file.name || 'file');
      const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendDocument`, { method: 'POST', body: fd });
      const d = (await r.json()) as { ok: boolean; description?: string };
      if (!d.ok) {
        // Partial failure: text was sent but file failed.
        // Return explicit error so client knows NOT to retry.
        const result = { ok: false, sent, total: files.length, partial: true, error: d.description, message: 'Текст отправлен, но файл не доставлен. Не повторяйте заявку — свяжитесь через ВКонтакте для отправки файлов.' };
        if (requestId) await storeIdempotency(env, requestId, result);
        return json(result, 200);
      }
      sent++;
    }

    const result = { ok: true, order: orderNum, files: sent };
    if (requestId) await storeIdempotency(env, requestId, result);
    return json(result, 200);
  } catch (err) {
    console.error('Order handler error:', err instanceof Error ? err.message : 'unknown');
    return json({ error: 'Internal error' }, 500);
  }
}

// ── Telegram proxy for reviews ──
async function handleReviewProxy(request: Request, env: Env): Promise<Response> {
  // Limit JSON body size
  const cl = request.headers.get('content-length');
  if (cl && parseInt(cl, 10) > MAX_JSON_BODY) {
    return json({ error: 'Request body too large' }, 413);
  }
  let body: { name?: string; text?: string; rating?: number; honeypot?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }
  try {
    
    // Honeypot check
    if (body.honeypot) {
      return json({ ok: true, silent: true }, 200);
    }
    
    if (!body.text || !body.name) {
      return json({ error: 'name and text required' }, 400);
    }
    
    // Validate lengths
    const name = String(body.name).substring(0, 100);
    const text = String(body.text).substring(0, 2000);
    const rating = Math.min(5, Math.max(1, Number(body.rating) || 5));
    
    if (name.trim().length < 2) {
      return json({ error: 'Имя слишком короткое' }, 400);
    }
    if (text.trim().length < 10) {
      return json({ error: 'Отзыв слишком короткий (минимум 10 символов)' }, 400);
    }
    
    // Escape HTML for Telegram
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const stars = '⭐'.repeat(rating);
    const fullText = `📝 Отзыв\n\n${esc(name)} (${stars})\n\n${esc(text)}`;
    
    const res = await sendMessage(env, fullText);
    return json({ ok: res.ok, description: res.description }, res.ok ? 200 : 400);
  } catch (err) {
    console.error('Review handler error:', err instanceof Error ? err.message : 'unknown');
    return json({ error: 'Internal error' }, 500);
  }
}

// ── Router ──
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_GET });
    }

    // Catalog API — public read only
    if (path === '/api/catalog') {
      if (request.method === 'GET') return getCatalog(env);
      if (request.method === 'POST') {
        return json({ error: 'Catalog write access is not publicly available' }, 405, { 'Allow': 'GET' });
      }
      return json({ error: 'Method not allowed' }, 405, { 'Allow': 'GET' });
    }

    // Telegram proxy for orders — POST only
    if (path === '/api/order' && request.method === 'POST') {
      return handleTelegramProxy(request, env);
    }
    
    // Telegram proxy for reviews — POST only
    if (path === '/api/review' && request.method === 'POST') {
      return handleReviewProxy(request, env);
    }

    // Legacy proxy endpoint — redirect to /api/order
    if (path === '/api/proxy' && request.method === 'POST') {
      return handleTelegramProxy(request, env);
    }

    // Telegram proxy — POST only (legacy catch-all)
    if (request.method === 'POST' && path === '/') {
      return handleTelegramProxy(request, env);
    }

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
