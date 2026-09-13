interface Env {
  BOT_TOKEN: string;
  CHAT_ID: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // CORS — разрешаем запросы с GitHub Pages
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'POST only' }), {
        status: 405,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    try {
      const body = await request.json() as { text: string };
      if (!body.text) {
        return new Response(JSON.stringify({ error: 'text required' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Ограничение длины сообщения (Telegram лимит 4096 символов)
      const text = body.text.substring(0, 4000);

      const tgUrl = `https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`;
      const res = await fetch(tgUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: env.CHAT_ID,
          text: text,
          parse_mode: 'HTML',
        }),
      });

      const data = await res.json() as { ok: boolean; description?: string };

      return new Response(JSON.stringify(data), {
        status: res.status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: 'Internal error' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  },
};
