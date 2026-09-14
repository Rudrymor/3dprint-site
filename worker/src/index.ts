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

// ── Telegram ──
async function sendMessage(env: Env, text: string): Promise<{ ok: boolean; description?: string }> {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: env.CHAT_ID, text, parse_mode: 'HTML' }),
  });
  return (await res.json()) as { ok: boolean; description?: string };
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
    return json(data, 200, { 'Cache-Control': 'public, max-age=60' });
  } catch {
    return json({ error: 'Invalid KV data' }, 500);
  }
}

async function postCatalog(request: Request, env: Env): Promise<Response> {
  // Принимает JSON { items: [...] } или { action: "add", item: {...} }
  const body = (await request.json()) as {
    items?: CatalogItem[];
    action?: string;
    item?: CatalogItem;
  };

  if (body.items && Array.isArray(body.items)) {
    // Полная замена каталога
    const data = { items: body.items, updated: new Date().toISOString() };
    await env.CATALOG_KV.put(CATALOG_KEY, JSON.stringify(data));
    return json({ ok: true, count: body.items.length }, 200);
  }

  if (body.action === 'add' && body.item) {
    // Добавление одной работы
    const raw = await env.CATALOG_KV.get(CATALOG_KEY);
    const data = raw ? JSON.parse(raw) : { items: [], updated: null };
    const items: CatalogItem[] = data.items || [];
    const maxId = items.reduce((m, i) => Math.max(m, i.id || 0), 0);
    body.item.id = maxId + 1;
    items.push(body.item);
    data.items = items;
    data.updated = new Date().toISOString();
    await env.CATALOG_KV.put(CATALOG_KEY, JSON.stringify(data));
    return json({ ok: true, id: body.item.id }, 200);
  }

  return json({ error: 'Provide items array or {action:"add", item:{...}}' }, 400);
}

// ── Telegram proxy (existing) ──
async function handleTelegramProxy(request: Request, env: Env): Promise<Response> {
  try {
    const contentType = request.headers.get('content-type') || '';

    // JSON { text }
    if (!contentType.includes('multipart/form-data')) {
      const body = (await request.json()) as { text?: string };
      if (!body.text) return json({ error: 'text required' }, 400);
      const res = await sendMessage(env, String(body.text).substring(0, 4000));
      return json(res, res.ok ? 200 : 400);
    }

    // multipart/form-data
    const form = await request.formData();
    const text = String(form.get('text') || '').substring(0, 4000);
    const files = form.getAll('files').filter((v): v is File => v instanceof File && v.size > 0);

    if (files.length > MAX_FILES) return json({ error: `Не больше ${MAX_FILES} файлов` }, 413);
    if (files.some((f) => f.size > MAX_FILE_SIZE) || files.reduce((s, f) => s + f.size, 0) > MAX_TOTAL_SIZE) {
      return json({ error: 'Файлы слишком большие' }, 413);
    }

    if (text) {
      const res = await sendMessage(env, text);
      if (!res.ok) return json(res, 400);
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
    return json({ ok: true, files: sent }, 200);
  } catch {
    return json({ error: 'Internal error' }, 500);
  }
}

// ── Router ──
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_GET });
    }

    // Catalog API
    if (path === '/api/catalog') {
      if (request.method === 'GET') return getCatalog(env);
      if (request.method === 'POST') return postCatalog(request, env);
      return json({ error: 'Method not allowed' }, 405);
    }

    // Telegram proxy — POST only (existing)
    if (request.method === 'POST') {
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
