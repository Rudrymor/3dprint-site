// worker/tests/run-tests.js — юнит + интеграционные тесты Worker'а без деплоя.
//
// Запуск из папки worker:
//   node tests/run-tests.js
//
// Что делает:
//   1. esbuild-бандлит src/index.ts и src/validators.ts в tmp/ (в репо не попадает);
//   2. гоняет validators (чистые функции) на edge-кейсах;
//   3. поднимает настоящий handler из src/index.ts с mock-Telegram и mock
//      Durable Object (реальная логика IdempotencyObject, только storage — Map);
//   4. проверяет контракт ответов: status success/partial/rejected/unknown/invalid,
//      idempotency, порядок валидации, отклонение файлов, honeypot, каталог.
//
// В реальный Telegram ничего не отправляется: global fetch подменён.
'use strict';

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
// Бандлы кладём в системный temp: путь без пробелов (в пути проекта есть пробел,
// из-за которого shell-обёртка npx разбивает --outfile на два аргумента).
const OUT = path.join(os.tmpdir(), '3dprint-worker-tests');
fs.mkdirSync(OUT, { recursive: true });

function bundle(entry, outfile) {
  execFileSync(
    'npx',
    ['esbuild', entry, '--bundle', '--platform=node', '--format=cjs',
      '"--outfile=' + outfile.replace(/\\/g, '/') + '"', '--log-level=error'],
    { cwd: ROOT, stdio: 'inherit', shell: true }
  );
  return require(outfile);
}

bundle('src/validators.ts', path.join(OUT, 'validators.cjs'));
bundle('src/index.ts', path.join(OUT, 'worker.cjs'));

const V = require(path.join(OUT, 'validators.cjs'));
const Worker = require(path.join(OUT, 'worker.cjs'));
const { IdempotencyObject } = Worker;

// ── микро-фреймворк ──
let passed = 0;
let failed = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) {
    passed++;
    console.log('  ✓ ' + name);
  } else {
    failed++;
    failures.push(name + (extra ? ' → ' + JSON.stringify(extra) : ''));
    console.log('  ✗ ' + name + (extra ? ' → ' + JSON.stringify(extra) : ''));
  }
}
function eq(name, actual, expected) {
  check(name + ' (got ' + JSON.stringify(actual) + ')', actual === expected, { actual, expected });
}
function section(title) {
  console.log('\n' + title);
}

// ── mock-инфраструктура ──
function makeStorage() {
  const m = new Map();
  return {
    get: async (k) => m.get(k),
    put: async (k, v) => { m.set(k, v); },
    delete: async (k) => { m.delete(k); },
  };
}

/** Настоящий IdempotencyObject, которому подменён storage (Map вместо SQLite). */
function makeFakeDO() {
  const objects = new Map();
  return {
    idFromName: (name) => name,
    get: (id) => ({
      fetch: (url, init) => {
        if (!objects.has(id)) objects.set(id, new IdempotencyObject({ storage: makeStorage() }, {}));
        return objects.get(id).fetch(new Request(url, init));
      },
    }),
    _size: () => objects.size,
  };
}

const noopKV = { get: async () => null, put: async () => {}, delete: async () => {} };

/** KV, который реально считает запросы — для проверки rate limit'а отзывов. */
function makeCountingKV() {
  const m = new Map();
  return {
    get: async (k) => (m.has(k) ? m.get(k) : null),
    put: async (k, v) => { m.set(k, v); },
    delete: async (k) => { m.delete(k); },
  };
}

const telegram = {
  calls: [],
  sendMessage: 'ok',   // 'ok' | 'fail' | 'throw'
  sendDocument: 'ok',  // 'ok' | 'fail'
};

globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes('/sendMessage')) {
    telegram.calls.push({ kind: 'message', body: JSON.parse(init.body) });
    if (telegram.sendMessage === 'throw') throw new Error('network down');
    if (telegram.sendMessage === 'fail') {
      return new Response(JSON.stringify({ ok: false, description: 'chat not found' }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
  }
  if (u.includes('/sendDocument')) {
    telegram.calls.push({ kind: 'document' });
    if (telegram.sendDocument === 'fail') {
      return new Response(JSON.stringify({ ok: false, description: 'file too big' }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
  }
  throw new Error('unexpected fetch: ' + u);
};

function resetTelegram() {
  telegram.calls = [];
  telegram.sendMessage = 'ok';
  telegram.sendDocument = 'ok';
}

function makeEnv() {
  return {
    BOT_TOKEN: 'test-token',
    CHAT_ID: '1',
    CATALOG_KV: noopKV,
    IDEMPOTENCY: makeFakeDO(),
    TURNSTILE_SECRET: undefined,
  };
}

function makeWorker(env, ip) {
  return (request) => {
    if (ip) request.headers.set('CF-Connecting-IP', ip);
    return Worker.default.fetch(request, env);
  };
}

const URL_ORDER = 'https://tg-proxy.metalkor91.workers.dev/api/order';
const UUID = () => crypto.randomUUID();

function multipartRequest(fields, files) {
  const fd = new FormData();
  Object.keys(fields).forEach((k) => fd.append(k, fields[k]));
  (files || []).forEach((f) => {
    fd.append('files', new File([f.content || 'x'], f.name, { type: f.type === undefined ? 'application/octet-stream' : f.type }), f.name);
  });
  return new Request(URL_ORDER, { method: 'POST', body: fd });
}

function jsonRequest(body) {
  return new Request(URL_ORDER, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const URL_REVIEW = 'https://tg-proxy.metalkor91.workers.dev/api/review';

function reviewRequest(body) {
  return new Request(URL_REVIEW, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const goodReview = (over) => Object.assign({
  name: 'Алексей',
  text: 'Заказывал кронштейн для регистратора — встал как родной.',
  rating: 5,
  request_id: UUID(),
}, over || {});

const goodFields = () => ({
  name: 'Иван',
  contact: '+79001234567',
  description: 'Нужен корпус для датчика, 12 см, с креплениями',
  material: 'PETG',
  color: 'чёрный',
  quantity: '2',
  request_id: UUID(),
});

/** Текст последнего сообщения в Telegram. */
function lastMessage() {
  for (let i = telegram.calls.length - 1; i >= 0; i--) {
    if (telegram.calls[i].kind === 'message') return telegram.calls[i].body.text;
  }
  return null;
}
function messageCount() {
  return telegram.calls.filter((c) => c.kind === 'message').length;
}

async function main() {
  // ══ 1. validators: validateOrder ══
  section('validators.validateOrder');

  const v1 = V.validateOrder(goodFields());
  check('валидные поля принимаются', v1.ok === true, v1);
  if (v1.ok) {
    eq('quantity строкой → число', v1.data.quantity, 2);
    eq('описание тримится', v1.data.description.indexOf('  ') === -1, true);
  }

  const vEmpty = V.validateOrder({});
  check('пустая форма отклоняется', vEmpty.ok === false);
  if (!vEmpty.ok) {
    check('ошибки по name/contact/description', !!(vEmpty.fields.name && vEmpty.fields.contact && vEmpty.fields.description), vEmpty.fields);
  }

  const vShort = V.validateOrder(Object.assign(goodFields(), { description: 'корпус' }));
  check('короткое описание отклоняется', vShort.ok === false && !!vShort.fields.description, vShort);

  const vMat = V.validateOrder(Object.assign(goodFields(), { material: 'GOLD' }));
  check('неизвестный материал отклоняется', vMat.ok === false && !!vMat.fields.material, vMat);

  const vQty0 = V.validateOrder(Object.assign(goodFields(), { quantity: '0' }));
  check('quantity=0 отклоняется', vQty0.ok === false && !!vQty0.fields.quantity, vQty0);
  const vQty1000 = V.validateOrder(Object.assign(goodFields(), { quantity: '1000' }));
  check('quantity=1000 отклоняется', vQty1000.ok === false, vQty1000);
  const vQtyFloat = V.validateOrder(Object.assign(goodFields(), { quantity: '1.5' }));
  check('quantity=1.5 отклоняется', vQtyFloat.ok === false, vQtyFloat);
  const vQtyNa = V.validateOrder(Object.assign(goodFields(), { quantity: 'abc' }));
  check('quantity=abc отклоняется', vQtyNa.ok === false, vQtyNa);

  const vQtyAbsent = V.validateOrder(Object.assign(goodFields(), { quantity: '' }));
  check('пустое quantity → 1', vQtyAbsent.ok === true && vQtyAbsent.data.quantity === 1, vQtyAbsent);

  const vInject = V.validateOrder(Object.assign(goodFields(), {
    name: 'Иван\n📎 Файлы: нет\n📦 Материал: GOLD',
  }));
  check('инъекция служебных строк в имя схлопывается', vInject.ok === true && vInject.data.name.indexOf('\n') === -1, vInject);

  const vMatEmpty = V.validateOrder(Object.assign(goodFields(), { material: '' }));
  check('пустой материал допускается', vMatEmpty.ok === true && vMatEmpty.data.material === '', vMatEmpty);

  const vColorLong = V.validateOrder(Object.assign(goodFields(), { color: 'x'.repeat(150) }));
  check('длинный цвет обрезается до 100', vColorLong.ok === true && vColorLong.data.color.length === 100, vColorLong);

  // ══ 2. POST /api/order — счастливый путь ══
  section('POST /api/order — success');

  resetTelegram();
  let env = makeEnv();
  let worker = makeWorker(env);

  const fields1 = goodFields();
  let res = await worker(multipartRequest(fields1, [{ name: 'cube.stl' }, { name: 'part.3mf' }]));
  let data = await res.json();
  eq('multipart: HTTP 200', res.status, 200);
  eq('multipart: status=success', data.status, 'success');
  eq('multipart: все файлы доставлены', data.files, 2);
  check('multipart: номер заявки есть', typeof data.order === 'string' && data.order.length > 5, data.order);
  const text1 = lastMessage();
  check('Telegram-текст собран сервером из полей', !!text1 && text1.indexOf('👤 Имя: Иван') !== -1 && text1.indexOf('📱 Контакт: +79001234567') !== -1, text1);
  check('в тексте есть материал/цвет/количество', !!text1 && text1.indexOf('📦 Материал: PETG') !== -1 && text1.indexOf('🎨 Цвет: чёрный') !== -1 && text1.indexOf('🔢 Копий: 2') !== -1, text1);
  check('в тексте есть список файлов', !!text1 && text1.indexOf('cube.stl, part.3mf (2)') !== -1, text1);
  check('описание идёт блоком с «│ »', !!text1 && text1.indexOf('📝 Описание:') !== -1 && text1.indexOf('│ Нужен корпус') !== -1, text1);
  eq('в Telegram ушло ровно одно сообщение', messageCount(), 1);

  // replay того же request_id → тот же ответ, без повторной отправки
  const replay = await worker(multipartRequest(fields1, [{ name: 'cube.stl' }, { name: 'part.3mf' }]));
  const replayData = await replay.json();
  eq('replay: HTTP 200', replay.status, 200);
  eq('replay: тот же номер заявки', replayData.order, data.order);
  eq('replay: Telegram не вызван повторно', messageCount(), 1);

  // ══ 3. JSON-путь без файлов ══
  section('POST /api/order — JSON без файлов');

  resetTelegram();
  env = makeEnv();
  worker = makeWorker(env);
  const fieldsJson = goodFields();
  res = await worker(jsonRequest(fieldsJson));
  data = await res.json();
  eq('JSON: HTTP 200', res.status, 200);
  eq('JSON: status=success', data.status, 'success');
  eq('JSON: файлов 0', data.files, 0);
  check('JSON: «Файлы: нет»', !!lastMessage() && lastMessage().indexOf('📎 Файлы: нет') !== -1, lastMessage());

  // ══ 4. Пустая / битая форма ══
  section('POST /api/order — валидация полей (BUG-01)');

  resetTelegram();
  env = makeEnv();
  worker = makeWorker(env);

  const emptyRes = await worker(jsonRequest({ request_id: UUID() }));
  const emptyData = await emptyRes.json();
  eq('пустая форма: HTTP 400', emptyRes.status, 400);
  eq('пустая форма: status=invalid', emptyData.status, 'invalid');
  check('пустая форма: ошибки по полям', !!(emptyData.fields && emptyData.fields.name && emptyData.fields.contact && emptyData.fields.description), emptyData.fields);
  eq('пустая форма: POST в Telegram не ушёл', messageCount(), 0);

  const shortRes = await worker(jsonRequest(Object.assign(goodFields(), { description: 'мало' })));
  eq('короткое описание: HTTP 400', shortRes.status, 400);
  eq('короткое описание: Telegram не вызван', messageCount(), 0);

  const badId = await worker(jsonRequest(Object.assign(goodFields(), { request_id: 'order-123' })));
  eq('не-UUID request_id: HTTP 400', badId.status, 400);
  const noId = await worker(jsonRequest(Object.assign(goodFields(), { request_id: undefined })));
  eq('отсутствующий request_id: HTTP 400', noId.status, 400);
  eq('после ошибок валидации Telegram не вызывался', messageCount(), 0);

  // ══ 5. Порядок валидации: отклонённый файл не «съедает» request_id ══
  section('POST /api/order — файлы и request_id');

  resetTelegram();
  env = makeEnv();
  worker = makeWorker(env);
  const ridFiles = UUID();

  const exeRes = await worker(multipartRequest(Object.assign(goodFields(), { request_id: ridFiles }), [{ name: 'virus.exe', type: '' }]));
  const exeData = await exeRes.json();
  eq('файл .exe с пустым MIME: HTTP 415', exeRes.status, 415);
  eq('.exe: status=invalid', exeData.status, 'invalid');
  eq('.exe: Telegram не вызван', messageCount(), 0);

  const retryRes = await worker(multipartRequest(Object.assign(goodFields(), { request_id: ridFiles }), [{ name: 'cube.stl' }]));
  const retryData = await retryRes.json();
  eq('повтор с тем же request_id после 415: HTTP 200', retryRes.status, 200);
  eq('повтор: status=success (request_id не «сожжён»)', retryData.status, 'success');
  eq('повтор: файл доставлен', retryData.files, 1);

  const tooBig = await worker(multipartRequest(Object.assign(goodFields(), { request_id: UUID() }), [{ name: 'big.stl', content: 'x'.repeat(16 * 1024 * 1024) }]));
  eq('файл > 15 МБ: HTTP 413', tooBig.status, 413);

  // ══ 6. partial: текст ушёл, файл — нет ══
  section('POST /api/order — partial');

  resetTelegram();
  env = makeEnv();
  worker = makeWorker(env);
  telegram.sendDocument = 'fail';
  const partRes = await worker(multipartRequest(goodFields(), [{ name: 'cube.stl' }, { name: 'part.3mf' }]));
  const partData = await partRes.json();
  eq('partial: HTTP 200 (текст доставлен)', partRes.status, 200);
  eq('partial: status=partial', partData.status, 'partial');
  eq('partial: sent=0', partData.sent, 0);
  eq('partial: total=2', partData.total, 2);
  check('partial: номер заявки в ответе', !!partData.order, partData.order);
  check('partial: текст уже ушёл в Telegram', messageCount() === 1, messageCount());

  // ══ 7. rejected и unknown ══
  section('POST /api/order — rejected / unknown');

  resetTelegram();
  env = makeEnv();
  worker = makeWorker(env);
  telegram.sendMessage = 'fail';
  const rejRes = await worker(jsonRequest(goodFields()));
  const rejData = await rejRes.json();
  eq('rejected: HTTP 502', rejRes.status, 502);
  eq('rejected: status=rejected', rejData.status, 'rejected');

  resetTelegram();
  env = makeEnv();
  worker = makeWorker(env);
  telegram.sendMessage = 'throw';
  const ridUnknown = UUID();
  const unkRes = await worker(jsonRequest(Object.assign(goodFields(), { request_id: ridUnknown })));
  const unkData = await unkRes.json();
  eq('unknown: HTTP 502', unkRes.status, 502);
  eq('unknown: status=unknown', unkData.status, 'unknown');
  eq('unknown: одна попытка отправки', messageCount(), 1);

  // повтор с тем же request_id не повторяет неопределённую операцию
  telegram.sendMessage = 'ok';
  const unkReplay = await worker(jsonRequest(Object.assign(goodFields(), { request_id: ridUnknown })));
  const unkReplayData = await unkReplay.json();
  eq('unknown replay: тот же статус', unkReplayData.status, 'unknown');
  eq('unknown replay: повторной отправки нет', messageCount(), 1);

  // ══ 8. honeypot и удалённый legacy-контракт ══
  section('POST /api/order — honeypot и удалённый legacy text');

  resetTelegram();
  env = makeEnv();
  worker = makeWorker(env);
  const honeyRes = await worker(jsonRequest({ request_id: UUID(), honeypot: 'spam-bot' }));
  const honeyData = await honeyRes.json();
  eq('honeypot: HTTP 200', honeyRes.status, 200);
  eq('honeypot: silent', honeyData.silent, true);
  eq('honeypot: Telegram не вызван', messageCount(), 0);

  // Легаси-контракт `text` удалён (этап 10): готовая строка больше не принимается.
  const legacyRes = await worker(jsonRequest({ request_id: UUID(), text: '👤 Имя: Пётр\n📝 Описание: старая схема клиента' }));
  const legacyData = await legacyRes.json();
  eq('legacy text: HTTP 400', legacyRes.status, 400);
  eq('legacy text: status=invalid', legacyData.status, 'invalid');
  check('legacy text: Telegram не вызван', messageCount() === 0, 'messages=' + messageCount());
  check('legacy text: карта ошибок по полям', !!legacyData.fields && Object.keys(legacyData.fields).length > 0, JSON.stringify(legacyData.fields));

  // ══ 9. Durable Object: pending-конкурент ══
  section('IdempotencyObject — параллельный дубликат');

  const doObj = new IdempotencyObject({ storage: makeStorage() }, {});
  const c1 = await doObj.fetch(new Request('https://idempotency.internal/claim', { method: 'POST' }));
  const c1Data = await c1.json();
  const c2 = await doObj.fetch(new Request('https://idempotency.internal/claim', { method: 'POST' }));
  eq('первый claim занят', c1Data.claimed, true);
  eq('параллельный claim: HTTP 409', c2.status, 409);
  const c2Data = await c2.json();
  eq('параллельный claim помечен pending', c2Data.pending, true);

  await doObj.fetch(new Request('https://idempotency.internal/finalize', {
    method: 'POST',
    body: JSON.stringify({ result: { ok: true, status: 'success', order: '260917-1' }, ttl: 60 }),
  }));
  const c3 = await doObj.fetch(new Request('https://idempotency.internal/claim', { method: 'POST' }));
  const c3Data = await c3.json();
  eq('после finalize claim отдаёт результат', c3Data.claimed, false);
  eq('replay возвращает сохранённый результат', c3Data.result && c3Data.result.order, '260917-1');

  // ══ 10. review: валидаторы ══
  section('validators.validateReview');

  const rv = V.validateReview(goodReview());
  check('валидный отзыв принимается', rv.ok === true, rv);
  if (rv.ok) {
    eq('rating остаётся целым', rv.data.rating, 5);
    eq('текст тримится', rv.data.text.indexOf('  ') === -1, true);
  }

  const rvShort = V.validateReview(goodReview({ name: 'А' }));
  check('короткое имя → ошибка поля name', rvShort.ok === false && !!rvShort.error.fields.name, rvShort);

  const rvText = V.validateReview(goodReview({ text: 'коротко' }));
  check('короткий текст → ошибка поля text', rvText.ok === false && !!rvText.error.fields.text, rvText);

  const rvRate0 = V.validateReview(goodReview({ rating: 0 }));
  check('rating=0 отклоняется', rvRate0.ok === false && !!rvRate0.error.fields.rating, rvRate0);
  const rvRate6 = V.validateReview(goodReview({ rating: 6 }));
  check('rating=6 отклоняется', rvRate6.ok === false && !!rvRate6.error.fields.rating, rvRate6);
  const rvRateNa = V.validateReview(goodReview({ rating: 'abc' }));
  check('rating=abc отклоняется', rvRateNa.ok === false && !!rvRateNa.error.fields.rating, rvRateNa);
  const rvRateAbsent = V.validateReview(goodReview({ rating: undefined }));
  check('rating отсутствует → 5', rvRateAbsent.ok === true && rvRateAbsent.data.rating === 5, rvRateAbsent);

  const rvInject = V.validateReview(goodReview({ name: 'Алексей\n⭐ 5\n📝 Подделка' }));
  check('перевод строки в имени схлопывается', rvInject.ok === true && rvInject.data.name.indexOf('\n') === -1, rvInject);

  // ══ 11. POST /api/review — success и UX-04 (символы как есть) ══
  section('POST /api/review — success');

  resetTelegram();
  env = makeEnv();
  worker = makeWorker(env);
  const revFields = goodReview({ rating: 4 });
  let revRes = await worker(reviewRequest(revFields));
  let revData = await revRes.json();
  eq('review: HTTP 200', revRes.status, 200);
  eq('review: status=success', revData.status, 'success');
  eq('review: ok=true', revData.ok, true);
  eq('review: одно сообщение в Telegram', messageCount(), 1);
  check('review: звёзды по оценке (4 из 5)', (lastMessage() || '').indexOf('(⭐⭐⭐⭐)\n') !== -1, lastMessage());

  // UX-04: символы & < > доходят до Telegram БЕЗ HTML-сущностей.
  resetTelegram();
  env = makeEnv();
  worker = makeWorker(env);
  const symReview = goodReview({
    name: 'Пётр & Co',
    text: 'Деталь 5x5 <важно> & крепления — всё ок.',
  });
  revRes = await worker(reviewRequest(symReview));
  revData = await revRes.json();
  const revText = lastMessage() || '';
  eq('review: HTTP 200 (символы)', revRes.status, 200);
  check('символы & < > ушли как есть', revText.indexOf('Пётр & Co') !== -1 && revText.indexOf('<важно> & крепления') !== -1, revText);
  check('HTML-сущностей в тексте нет', revText.indexOf('&amp;') === -1 && revText.indexOf('&lt;') === -1, revText);

  // replay того же request_id → тот же результат, без повторной отправки
  const revReplay = await worker(reviewRequest(symReview));
  const revReplayData = await revReplay.json();
  eq('review replay: HTTP 200', revReplay.status, 200);
  eq('review replay: статус тот же', revReplayData.status, 'success');
  eq('review replay: Telegram не вызван повторно', messageCount(), 1);

  // ══ 12. POST /api/review — отказы валидации, honeypot, request_id ══
  section('POST /api/review — invalid / honeypot / request_id');

  resetTelegram();
  env = makeEnv();
  worker = makeWorker(env);

  const revEmpty = await worker(reviewRequest({ request_id: UUID() }));
  const revEmptyData = await revEmpty.json();
  eq('пустой отзыв: HTTP 400', revEmpty.status, 400);
  eq('пустой отзыв: status=invalid', revEmptyData.status, 'invalid');
  check('пустой отзыв: ошибки по полям', !!(revEmptyData.fields && revEmptyData.fields.name && revEmptyData.fields.text), revEmptyData.fields);
  eq('пустой отзыв: Telegram не вызван', messageCount(), 0);

  const revBadId = await worker(reviewRequest(goodReview({ request_id: 'review-1' })));
  eq('не-UUID request_id: HTTP 400', revBadId.status, 400);
  const revNoId = await worker(reviewRequest(goodReview({ request_id: undefined })));
  eq('отсутствующий request_id: HTTP 400', revNoId.status, 400);

  const revHoney = await worker(reviewRequest({ request_id: UUID(), honeypot: 'spam-bot' }));
  const revHoneyData = await revHoney.json();
  eq('honeypot: HTTP 200', revHoney.status, 200);
  eq('honeypot: silent', revHoneyData.silent, true);
  eq('honeypot: Telegram не вызван', messageCount(), 0);

  // ══ 13. POST /api/review — rejected / unknown ══
  section('POST /api/review — rejected / unknown');

  resetTelegram();
  env = makeEnv();
  worker = makeWorker(env);
  telegram.sendMessage = 'fail';
  const revRej = await worker(reviewRequest(goodReview()));
  const revRejData = await revRej.json();
  eq('review rejected: HTTP 502', revRej.status, 502);
  eq('review rejected: status=rejected', revRejData.status, 'rejected');

  resetTelegram();
  env = makeEnv();
  worker = makeWorker(env);
  telegram.sendMessage = 'throw';
  const revRidUnknown = UUID();
  const revUnk = await worker(reviewRequest(goodReview({ request_id: revRidUnknown })));
  const revUnkData = await revUnk.json();
  eq('review unknown: HTTP 502', revUnk.status, 502);
  eq('review unknown: status=unknown', revUnkData.status, 'unknown');
  eq('review unknown: одна попытка отправки', messageCount(), 1);

  telegram.sendMessage = 'ok';
  const revUnkReplay = await worker(reviewRequest(goodReview({ request_id: revRidUnknown })));
  const revUnkReplayData = await revUnkReplay.json();
  eq('review unknown replay: тот же статус', revUnkReplayData.status, 'unknown');
  eq('review unknown replay: повторной отправки нет', messageCount(), 1);

  // ══ 14. POST /api/review — rate limit (3/ч → 429) ══
  section('POST /api/review — rate limit');

  resetTelegram();
  env = makeEnv();
  env.CATALOG_KV = makeCountingKV();
  worker = makeWorker(env, '10.0.0.7');

  const rl1 = await worker(reviewRequest(goodReview()));
  const rl2 = await worker(reviewRequest(goodReview()));
  const rl3 = await worker(reviewRequest(goodReview()));
  eq('rate limit: 1-й отзыв 200', rl1.status, 200);
  eq('rate limit: 2-й отзыв 200', rl2.status, 200);
  eq('rate limit: 3-й отзыв 200', rl3.status, 200);
  eq('rate limit: в Telegram ушло 3 отзыва', messageCount(), 3);

  const rl4 = await worker(reviewRequest(goodReview()));
  const rl4Data = await rl4.json();
  eq('rate limit: 4-й отзыв 429', rl4.status, 429);
  eq('rate limit: status=ratelimited', rl4Data.status, 'ratelimited');
  eq('rate limit: 4-й отзыв в Telegram не ушёл', messageCount(), 3);

  // другой IP не заблокирован
  const workerOtherIp = makeWorker(env, '10.0.0.8');
  const rlOther = await workerOtherIp(reviewRequest(goodReview()));
  eq('rate limit: другой IP проходит', rlOther.status, 200);

  // ══ 15. роутер ══
  section('Роутер и каталог');

  resetTelegram();
  env = makeEnv();
  worker = makeWorker(env);

  const catalogRes = await worker(new Request('https://tg-proxy.metalkor91.workers.dev/api/catalog'));
  eq('GET /api/catalog → 200', catalogRes.status, 200);
  const catalogPost = await worker(new Request('https://tg-proxy.metalkor91.workers.dev/api/catalog', { method: 'POST' }));
  eq('POST /api/catalog → 405', catalogPost.status, 405);
  const proxy = await worker(new Request('https://tg-proxy.metalkor91.workers.dev/api/proxy', { method: 'POST' }));
  eq('POST /api/proxy → 404 (legacy удалён)', proxy.status, 404);
  const root = await worker(new Request('https://tg-proxy.metalkor91.workers.dev/', { method: 'POST' }));
  eq('POST / → 404', root.status, 404);
  const badMethod = await worker(new Request(URL_ORDER));
  eq('GET /api/order → 405', badMethod.status, 405);
  const badReviewMethod = await worker(new Request(URL_REVIEW));
  eq('GET /api/review → 405', badReviewMethod.status, 405);

  // ── итог ──
  console.log('\n' + '─'.repeat(60));
  console.log('Пройдено: ' + passed + ' | Провалено: ' + failed);
  if (failed) {
    console.log('\nПровалы:');
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
  console.log('Все проверки пройдены.');
}

main().catch((err) => {
  console.error('Харнесс упал:', err);
  process.exit(1);
});
