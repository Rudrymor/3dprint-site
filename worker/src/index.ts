interface Env {
  BOT_TOKEN: string;
  CHAT_ID: string;
  CATALOG_KV: KVNamespace;
}
const MAX_FILES = 5;
const MAX_FILE_SIZE = 50 * 1024 * 1024;
const MAX_TOTAL_SIZE = 50 * 1024 * 1024;

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

    // JSON { text, honeypot }
    if (!contentType.includes('multipart/form-data')) {
      let body: { text?: string; honeypot?: string };
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
      return json({ ok: res.ok, order: orderNum, description: res.description }, res.ok ? 200 : 400);
    }

    // multipart/form-data
    const form = await request.formData();
    
    // Honeypot check
    const honeypot = form.get('honeypot');
    if (honeypot) {
      return json({ ok: true, silent: true }, 200);
    }
    
    const text = String(form.get('text') || '').substring(0, 4000);
    
    // Validate text length
    if (text.trim().length < 10) {
      return json({ error: 'Текст слишком короткий (минимум 10 символов)' }, 400);
    }
    
    const files = form.getAll('files').filter((v): v is File => v instanceof File && v.size > 0);

    if (files.length > MAX_FILES) return json({ error: `Не больше ${MAX_FILES} файлов` }, 413);
    if (files.some((f) => f.size > MAX_FILE_SIZE) || files.reduce((s, f) => s + f.size, 0) > MAX_TOTAL_SIZE) {
      return json({ error: 'Файлы слишком большие' }, 413);
    }
    
    // Validate file types (allow common document types)
    const ALLOWED_TYPES = [
      'image/jpeg', 'image/png', 'image/gif', 'image/webp',
      'application/pdf',
      'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
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
      if (!res.ok) return json({ ok: false, order: orderNum, description: res.description }, 400);
    }

    let sent = 0;
    for (const file of files) {
      const fd = new FormData();
      fd.append('chat_id', env.CHAT_ID);
      fd.append('document', file, file.name || 'file');
      const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendDocument`, { method: 'POST', body: fd });
      const d = (await r.json()) as { ok: boolean; description?: string };
      if (!d.ok) return json({ ok: false, sent, error: d.description }, 400);
      sent++;
    }
    return json({ ok: true, order: orderNum, files: sent }, 200);
  } catch (err) {
    console.error('Order handler error:', err instanceof Error ? err.message : 'unknown');
    return json({ error: 'Internal error' }, 500);
  }
}

// ── Telegram proxy for reviews ──
async function handleReviewProxy(request: Request, env: Env): Promise<Response> {
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
