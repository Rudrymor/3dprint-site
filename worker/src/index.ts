interface Env {
  BOT_TOKEN: string;
  CHAT_ID: string;
}

const MAX_FILES = 5;
const MAX_FILE_SIZE = 50 * 1024 * 1024; // лимит Telegram Bot API на документ
const MAX_TOTAL_SIZE = 50 * 1024 * 1024; // суммарный лимит на одну заявку

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

/** Отправка текста в Telegram. Общая для заявок и отзывов. */
async function sendMessage(env: Env, text: string): Promise<{ ok: boolean; description?: string }> {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: env.CHAT_ID,
      text,
      parse_mode: 'HTML',
    }),
  });
  return (await res.json()) as { ok: boolean; description?: string };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    if (request.method !== 'POST') {
      return json({ error: 'POST only' }, 405);
    }

    try {
      const contentType = request.headers.get('content-type') || '';

      // ── Вариант 1: JSON { text } — отзывы и старые версии формы ──
      if (!contentType.includes('multipart/form-data')) {
        const body = (await request.json()) as { text?: string };
        if (!body.text) {
          return json({ error: 'text required' }, 400);
        }
        const res = await sendMessage(env, String(body.text).substring(0, 4000));
        return json(res, res.ok ? 200 : 400);
      }

      // ── Вариант 2: multipart/form-data — текст заявки + файлы с компьютера ──
      const form = await request.formData();
      const text = String(form.get('text') || '').substring(0, 4000);
      const files = form
        .getAll('files')
        .filter((v): v is File => v instanceof File && v.size > 0);

      if (files.length > MAX_FILES) {
        return json({ error: `Не больше ${MAX_FILES} файлов` }, 413);
      }
      const total = files.reduce((sum, f) => sum + f.size, 0);
      if (files.some((f) => f.size > MAX_FILE_SIZE) || total > MAX_TOTAL_SIZE) {
        return json({ error: 'Файлы слишком большие' }, 413);
      }

      if (text) {
        const res = await sendMessage(env, text);
        if (!res.ok) {
          return json(res, 400);
        }
      }

      // Файлы уходят отдельными сообщениями как документы — их можно скачать и распечатать
      let sent = 0;
      for (const file of files) {
        const fd = new FormData();
        fd.append('chat_id', env.CHAT_ID);
        fd.append('document', file, file.name || 'file');
        const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendDocument`, {
          method: 'POST',
          body: fd,
        });
        const d = (await r.json()) as { ok: boolean; description?: string };
        if (!d.ok) {
          return json({ ok: false, sent, error: d.description }, 400);
        }
        sent++;
      }

      return json({ ok: true, files: sent }, 200);
    } catch (err) {
      return json({ error: 'Internal error' }, 500);
    }
  },
};
