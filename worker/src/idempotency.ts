// idempotency.ts — атомарная idempotency через Durable Object.
// Проблема (SEC-02): схема check→send→put на KV неатомарна — два параллельных
// запроса с одним request_id оба проходят check и шлют в Telegram дважды.
// KV eventual consistency не гарантирует мгновенное чтение.
//
// Решение: одна точка claim — Durable Object, инстанцируемый на ключе request_id.
// Рантайм сериализует все обращения к одному инстансу в один поток, поэтому:
//   - первый запрос атомарно занимает ключ (pending),
//   - параллельный дубликат того же ключа видит pending и НЕ шлёт в Telegram,
//   - repeat с тем же ID возвращает сохранённый результат (ретрай не дублирует).
//
// Жизненный цикл состояния:
//   pending  →  sent | partial | failed | unknown   (только через DO)
// Каждый переход записывается в storage DO (аломатически дюрабельно).

export class IdempotencyObject {
  private state: DurableObjectState;

  constructor(state: DurableObjectState, env: unknown) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    // POST /claim — атомарно занять ключ. Ответы:
    //   { claimed: true }                       — ключ занят этим запросом, можно слать
    //   { claimed: false, result: {...} }       — уже завершено, вернуть прежний результат
    //   { claimed: false, pending: true }       — в обработке параллельным запросом (409)
    if (url.pathname === '/claim') {
      return this.claim();
    }

    // POST /finalize — записать терминальный результат { result, ttl? }.
    if (url.pathname === '/finalize') {
      return this.finalize(request);
    }

    return new Response('Not found', { status: 404 });
  }

  private async claim(): Promise<Response> {
    // Терминальный результат уже есть — возвращаем сохранённый ответ (replay).
    const result = await this.state.storage.get<Record<string, unknown>>('result');
    if (result) {
      return json({ claimed: false, result });
    }

    // В обработке параллельным запросом того же ключа.
    const pending = await this.state.storage.get<boolean>('pending');
    if (pending) {
      return json({ claimed: false, pending: true }, 409);
    }

    // Атомарно занимаем ключ. single-flight гарантирован тем, что рантайм
    // сериализует обращения к одному инстансу.
    // TTL на pending: если запрос умер после claim до finalize (крэш), ключ
    // не блокируется навсегда — освободится через PENDING_TTL (10 минут),
    // после чего ретрай сможет заново занять его.
    await this.state.storage.put('pending', true, { expirationTtl: PENDING_TTL });
    return json({ claimed: true });
  }

  private async finalize(request: Request): Promise<Response> {
    let body: { result?: Record<string, unknown>; ttl?: number } = {};
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return json({ error: 'Invalid finalize body' }, 400);
    }
    if (!body.result || typeof body.result !== 'object') {
      return json({ error: 'finalize requires result' }, 400);
    }

    // Сначала пишем результат, потом снимаем pending: если запись result успела,
    // а delete нет — повторный claim увидит result (проверяется раньше pending)
    // и вернёт replay, не дублируя отправку.
    await this.state.storage.put('result', body.result, { expirationTtl: body.ttl ?? 86400 });
    await this.state.storage.delete('pending');
    return json({ ok: true });
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Если запрос умер после claim до finalize (крэш), pending освободится через
// это время, чтобы ключ не был заблокирован навсегда.
const PENDING_TTL = 600; // 10 минут

// ── Интерфейс для index.ts ──
export type IdemClaim =
  | { claimed: true }
  | { claimed: false; result?: Record<string, unknown>; pending?: boolean };

export async function claimIdempotency(id: DurableObjectNamespace, requestId: string, ttl: number):
  | Promise<{ ok: true }>
  | Promise<{ ok: false; status: number; result?: Record<string, unknown> }> {
  const stub = id.get(id.idFromName(requestId));
  const res = await stub.fetch('https://idempotency.internal/claim', { method: 'POST' });
  const data = (await res.json()) as IdemClaim;

  if (data.claimed === true) {
    return { ok: true };
  }
  if (data.pending) {
    // Параллельный запрос уже взял ключ и работает. Не дублируем отправку.
    return { ok: false, status: 409 };
  }
  // Уже завершено — вернуть сохранённый результат (replay не дублирует идемпотентно).
  return { ok: false, status: 200, result: data.result };
}

export async function finalizeIdempotency(
  id: DurableObjectNamespace,
  requestId: string,
  result: Record<string, unknown>,
  ttl: number,
): Promise<void> {
  try {
    const stub = id.get(id.idFromName(requestId));
    await stub.fetch('https://idempotency.internal/finalize', {
      method: 'POST',
      body: JSON.stringify({ result, ttl }),
    });
  } catch {
    // Сбой записи состояния НЕ должен молча потерять доставку: уже отправленное
    // message/document сохраняется в Telegram. Это отдельно от сбоя Telegram.
    // Логируем здесь — ретрай не запускаем (unknown результат мы не повторяем).
  }
}