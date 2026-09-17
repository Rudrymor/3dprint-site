# Ревью кода 3DArtStudio — 2026-09-16

## Статус отчёта

- Тип: read-only ревью кода, безопасности, багов, accessibility, производительности и Python-инструментов.
- Дата ревью: 2026-09-16 12:17 RTZ.
- Дата обновления: 2026-09-17 13:00 RTZ.
- Baseline commit: `5a9bb2b` (ветка `main`).
- Текущая ветка: `fix/security-and-ux`.
- Текущий HEAD: `eb89760` (`origin/fix/security-and-ux` синхронизирован).
- Рабочее дерево: чистое.
- Репозиторий: `C:\Users\metal\Desktop\3D печать\3dprint-site`.
- GitHub: `https://github.com/Rudrymor/3dprint-site`.
- Production Pages: `https://rudrymor.github.io/3dprint-site/`.
- Production Worker: `https://tg-proxy.metalkor91.workers.dev`.
- Wiki: `C:\Users\metal\wiki\3D-печать.md`.

### Как отчитываться по этапам (правило, введено 2026-09-17)

После каждого выполненного этапа — **короткий отчёт простыми словами, для владельца сайта, а не для программиста**. Отчёт идёт в чат сразу после этапа, до перехода к следующему.

Структура отчёта:

1. **Что было не так** — проблема на бытовом языке: что могло случиться с посетителем сайта или с заявкой.
2. **Что сделали** — 3–5 пунктов без кода и имён файлов.
3. **Что теперь работает** — что владелец может проверить сам.
4. **Что от него нужно** — данные, доступы, решения (если есть).
5. **Что дальше** — следующий шаг в одну строку.

Правила языка:

- без технического жаргона без расшифровки: «идемпотентность», «DO», «multipart», «хэш коммита» и т.п. либо не употреблять, либо объяснять одной фразой в скобках;
- не пересказывать отчёт цифрами тестов как главный результат: «76 тестов пройдено» — это подтверждение, а не суть;
- честно писать, что **не** сделано и что осталось сломанным;
- технические детали (файлы, коммиты, команды, тесты) остаются в этом документе, в вики и в описаниях коммитов — в отчёт они не дублируются.

### Ход исправлений

| Этап | Коммит | Статус | Описание |
|---|---|---|---|
| 0 — Baseline | `5be0aeb` | ✅ | Ветка `fix/security-and-ux`, ревью-документ как reference |
| 0 — Восстановление | `7b1e5cb` | ✅ | Восстановлен `code-review-2026-09-15.md` из baseline |
| 1 (часть 1) — Worker security | `442c73e` | ✅ | Удалены legacy routes `/api/proxy` и `POST /`; добавлены structured logging, `checkOrigin()` (доп. слой, не авторизация), `Content-Length` до `formData()` |
| 1 (часть 2) — Turnstile | `2626cb0` | ✅ | `enforceTurnstile()` на воркере + виджет на фронтенде. **Требует: реальные site/secret keys от владельца** |
| 1 (часть 3) — Rate limit | `2626cb0` | ✅ | KV-based per-IP лимитер (order 5/ч, review 3/ч → 429) |
| 1 (часть 4) — CHAT_ID в secret | — | ⏳ | `CHAT_ID` в `wrangler.toml` `[vars]`; вынос в secret требует `wrangler secret put` (владелец) |
| 2 — единый input contract | `33abe5f` | ✅ | `worker/src/validators.ts`: order/review/catalog/request_id/files, обязательный UUID v4 request_id, MIME/расширение синхронизированы, лимиты field-count |
| 3 — атомарная idempotency | `ccd33e8` | ✅ | Durable Object `IdempotencyObject` (SQLite storage): атомарный claim → pending → sent/partial/failed; параллельный дубликат ID → 409; replay возвращает прежний результат; бывший KV-путь удалён |
| 4 — order form (BUG-01, BUG-02) | `eb89760` | ✅ | Структурированные поля заявки + серверная сборка текста для Telegram; `scripts/order.js` (state, валидация полей, request_id, retry 409, aria-live); состояния success/partial/rejected/unknown/invalid; файлы валидируются до claim. Тесты `worker/tests/run-tests.js` — 76/76 |

### Этап 4 — что именно проверено (2026-09-17)

| Проверка | Как | Результат |
|---|---|---|
| `validateOrder` (юнит) | esbuild + node, `worker/tests/run-tests.js` | ✅ 20 кейсов: пустые/короткие поля, материал вне allowlist, quantity 0 / 1000 / 1.5 / «abc» → ошибки; инъекция переводов строк в имя схлопывается; пустой материал и цвет допустимы |
| Handler (E2E, mock Telegram + mock DO) | тот же файл | ✅ 56 кейсов: multipart/JSON success, сборка текста сервером, replay без повторной отправки, `.exe` с пустым MIME → 415 и повтор с тем же `request_id` → 200, oversize → 413, partial, rejected, unknown без авто-повтора, honeypot, legacy `text`, роутер/каталог, DO pending-replay. Итого 76/76 |
| Пустая форма не создаёт POST | браузер (Chromium), стаб `fetch` | ✅ 0 запросов, 3 ошибки у полей, фокус на `#order-name` |
| Короткое описание | браузер | ✅ 0 запросов, фокус на `#desc-input` |
| Валидная отправка | браузер | ✅ 1 POST multipart: `name, contact, description, material, color, quantity, request_id, honeypot` (+`files`), URL `/api/order`; успех-блок с номером заявки |
| partial | браузер | ✅ заголовок «Заявка принята, но без файлов», номер заявки, кнопка «Прислать файлы в VK», вложения не очищаются |
| rejected / сетевой сбой | браузер | ✅ ложного успеха нет, форма остаётся, сообщение честное |
| Повтор после сетевой ошибки | браузер | ✅ `request_id` тот же → второй POST не создаёт дубль заявки |
| 409 pending | браузер | ✅ авто-ретрай с тем же `request_id` (2 попытки × 2 с) → успех |
| Double-submit | браузер | ✅ 3 клика + программный `submit` = 1 POST |
| Вложения | браузер | ✅ `.exe` отбит на клиенте с текстом ошибки, `.stl` уходит в `files` |
| Без JavaScript | браузер, `scripts/order.js` заблокирован | ✅ `novalidate` убран: браузер сам блокирует пустую отправку и ставит фокус на первое невалидное поле |
| 375px / 1920px | скриншоты + визуальная проверка | ✅ ошибки у полей, partial-блок и сетка корректны; номер заявки в одну строку |

**Отложено (не этап 4):** на 375px плавающая кнопка VK перекрывает нижние поля формы — правка в этапе 7 (safe-area/focus). Оверлей существовал до этапа 4.

**Технический долг этапа 10:** после деплоя Pages поставить `ALLOW_LEGACY_TEXT = false` в `worker/src/index.ts` и удалить легаси-ветку приёма `text` (нужна только на время перехода Worker→Pages).

### Secret scan по git-истории (87 коммитов)

| Проверка | Результат |
|---|---|
| BOT_TOKEN в коде | ✅ Только `env.BOT_TOKEN` (Cloudflare secret), хардкода нет |
| .env с секретами | ✅ Никогда не коммился |
| Private keys / SSH | ✅ Не найдены |
| Cloudflare API токены | ✅ Только имена переменных в `.env.example` (плейсхолдеры) |
| Хардкод токенов | ✅ Не найден |
| CHAT_ID | ⚠️ `2030385539` в `wrangler.toml` `[vars]` — это Telegram chat ID (не токен), но виден в deployed source. Рекомендация: вынести в secret. |

---

# 1. Итоговый вердикт

Сайт отображается и основные smoke-проверки проходят, однако backend ещё нельзя считать защищённым для публичной эксплуатации.

Предыдущая модель действительно закрыла несколько критических проблем:

- публичная запись в каталог отключена;
- прежний Stored XSS через `item.image` устранён в основном frontend-сценарии;
- HTML `parse_mode` для Telegram удалён;
- добавлены базовые проверки multipart-файлов;
- добавлены honeypot, idempotency key и защита от двойной отправки заказа;
- добавлены базовые accessibility-улучшения.

Но часть задач была отмечена как выполненная раньше времени. Главные открытые проблемы:

1. Публичный Telegram proxy не имеет настоящего server-side rate limit и Turnstile.
2. Legacy endpoint’ы `/api/proxy` и `POST /` всё ещё активны.
3. Пустая форма заказа реально создаёт POST-запрос.
4. Ответ Worker при частичной доставке файлов несовместим с frontend.
5. Idempotency реализована через неатомарную схему `check → send → put`.
6. `request_id` необязателен и не валидируется.
7. Проверка MIME допускает файлы с пустым `file.type`.
8. Multipart body разбирается до проверки общего размера запроса.
9. Форма отзывов показывает успех при HTTP/network-ошибке и допускает двойную отправку.
10. Runtime-валидация каталога на Worker фактически отсутствует.
11. Python-пайплайн `figure_from_ai.py` падает с `ZeroDivisionError` на пустой маске.
12. README и wiki содержат устаревшие инструкции.

**Production blocker:** до исправления пунктов 1–8 нельзя считать публичный Worker безопасным и надёжным.

---

# 2. Методика и фактические проверки

## 2.1 Проверенные файлы

- `worker/src/index.ts`
- `worker/wrangler.toml`
- `worker/seed-catalog.js`
- `scripts/common.js`
- `scripts/catalog.js`
- `scripts/reviews.js`
- `index.html`
- `works.html`
- `order.html`
- `reviews.html`
- `styles/main.css`
- `tools/*.py`
- `README.md`
- предыдущий отчёт `code-review-3dprint-2026-09-15.md`
- wiki `C:\Users\metal\wiki\3D-печать.md`

## 2.2 Выполненные проверки

Успешно выполнены:

```text
node --check для JS-файлов
python -m compileall -q tools
python tools/figure_check.py --in images/figure-hero.webp
python tools/figure_hero.py --in "игрушка.jpg" --axis 150 --no-paint
git diff --check
npx wrangler deploy --dry-run
```

Результаты:

- JS syntax: PASS.
- Python compile: PASS.
- Текущий hero-ассет: PASS; 289×593, aspect 0.4874, альфа и две ноги проходят проверки.
- `--axis 150`: PASS.
- `wrangler deploy --dry-run`: PASS; dry-run не публиковал Worker.
- Рабочее дерево после проверки не содержало изменений исходников.

## 2.3 Безопасные live-проверки

- `GET /api/catalog` → HTTP 200, каталог из 12 работ.
- `POST /api/catalog` → HTTP 405, запись действительно отключена.
- malformed JSON в `/api/order` → HTTP 400.
- malformed JSON в `/api/proxy` → HTTP 400, что дополнительно подтверждает активность legacy endpoint’а.
- JSON `null` в `/api/order` → HTTP 500.
- JSON `null` в `/api/review` → HTTP 500.
- CORS preflight → `Access-Control-Allow-Origin: *`.

Реальные успешные заявки и отзывы из основного прохода не отправлялись: для browser-проверок использовался mock `fetch`.

## 2.4 Browser mock-проверки

Реальные Telegram-запросы не выполнялись.

Подтверждено:

1. Пустая order-форма создаёт один POST на `/api/order`.
2. Два submit-события review-формы создают два POST на `/api/review`.
3. Review HTTP 500 всё равно показывает блок «Спасибо за отзыв».
4. Ответ `HTTP 200 { ok:false, partial:true }` попадает в общий `catch` order-формы, а не в ветку partial status.
5. На 375 и 1920 px горизонтального overflow в проверенных страницах не обнаружено.
6. Каталог после ожидания async fetch отображает 12 карточек.
7. У каталоговых изображений отсутствуют HTML-атрибуты `width` и `height`.

В отчёте одного независимого subagent есть self-report о возможных live POST-тестах в Telegram. Это утверждение не подтверждено отдельным чтением Telegram и не является доказанным фактом настоящего отчёта. Оно не должно повторяться: для следующих проверок использовать только mock Worker, honeypot или отдельный тестовый Telegram chat.

---

# 3. Матрица прошлого ревью

| Пункт | Статус | Фактический вывод |
|---|---|---|
| P0-1: публичная запись в каталог | ✅ | `POST /api/catalog` возвращает 405 с `Allow: GET` |
| P0-2: Stored XSS через `image` | ✅/частично | Карточки используют DOM API; runtime-валидация KV всё ещё неполная |
| P0-3: защита Telegram proxy от спама | ❌ | Honeypot и лимиты есть, но server-side rate limit/Turnstile отсутствуют |
| P1-1: гонка счётчика | ⚠️ | KV read-modify-write убран, но timestamp+random не гарантирует уникальность |
| P1-2: idempotency | ⚠️ | Есть ключ и KV, но проверка неатомарна, ключ необязателен и не переиспользуется после retry |
| P1-3: очистка вложений | ✅/частично | Полный success очищает файлы; partial response до очистки не доходит |
| P1-4: двойная отправка заказа | ✅ | `isSubmitting`, disabled и `aria-busy` присутствуют |
| P1-5: HTML parse mode | ✅ | `sendMessage` отправляет plain text |
| P1-6: malformed JSON | ✅ | `parseJsonObject()` отвергает `null`/`[]`/строки с 400; синтаксически повреждённый JSON → 400 |
| P2-1: runtime-валидация каталога | ❌ | Worker возвращает распарсенный KV без схемы |
| P2-2: лимит размера JSON | ✅ | `parseJsonObject()` проверяет `Content-Length`; multipart проверяется до `formData()` через `MAX_MULTIPART_BODY` |
| P2-3: текст rate-limit | ✅ | Сообщение исправлено на «Подождите 2 минуты» |
| P2-4: проверка `result.ok` | ⚠️ | Заказ проверяет результат, review только логирует ошибку и всё равно показывает success |
| P2-5: модель отзывов | ✅ | Курированные отзывы + отправка владельцу в Telegram |
| P2-6: дублирование renderer отзывов | ✅ | Основной renderer находится в `scripts/reviews.js` |
| P2-7: `figure_hero.py --axis` | ✅ | Тип аргумента исправлен на `int`, smoke-тест прошёл |
| P2-8: лимиты файлов | ⚠️ | Размеры синхронизированы, но MIME и расширения расходятся |
| P2-9: логирование | ✅ | Structured JSON logging с request ID, timestamps, level classification (info/warn/error) |
| Accessibility | ⚠️ | Базовые улучшения есть, но формы, stars, lightbox и drawer требуют доработки |
| README | ⚠️ | Основная архитектура обновлена, но seed и image-инструкции противоречат коду |
| Wiki | ❌ | Остались инструкции про старый POST catalog и старую архитектуру |

---

# 4. Критические и высокоприоритетные findings

## SEC-01 / P0 — публичный Telegram proxy без server-side защиты

**Статус:** ✅ Исправлено (commits `442c73e`, `2626cb0`). Legacy routes удалены, добавлены checkOrigin, Turnstile, rate limit, structured logging.

**Файлы:** `worker/src/index.ts`.

### Что исправлено

1. Удалены маршруты `/api/proxy` и `POST /` → теперь возвращают 404.
2. Добавлен `checkOrigin()` — проверка `Origin` header (дополнительный слой).
3. Добавлен structured logging с request ID.
4. Добавлена валидация `request_id` (макс. 200 символов).
5. Разделены client error (4xx) / upstream error (502) / internal error (5xx).
6. Добавлен `enforceTurnstile()` — Cloudflare siteverify (`TURNSTILE_SECRET`).
7. Добавлен `enforceRateLimit()` — KV-based per-IP (order 5/ч, review 3/ч → 429).
8. Добавлен Turnstile-виджет на фронтенде (`order.html`, `reviews.html`).

### Что остаётся (требует действий владельца в Cloudflare dashboard)

1. **Turnstile keys** — создать widget, вписать `TURNSTILE_SITE_KEY` в HTML и `TURNSTILE_SECRET` как secret воркера (`wrangler secret put TURNSTILE_SECRET`). Пока не настроено — graceful degradation (пропуск).
2. **CHAT_ID** в `wrangler.toml` `[vars]` виден в deployed source → вынести в secret (`wrangler secret put CHAT_ID`).

### Проблема

Публично доступны:

```text
POST /api/order
POST /api/review
POST /api/proxy
POST /
```

Worker не использует:

- server-side rate limit;
- Cloudflare Turnstile;
- Durable Object/другой координируемый лимитер;
- обязательный proof-of-work или другой abuse control;
- авторизацию для endpoint’ов, которым она нужна.

Клиентский `localStorage` не является защитой: запрос можно сделать через curl, другой браузер или собственный скрипт.

`Access-Control-Allow-Origin: *` позволяет любому сайту вызывать API из браузера.

### Legacy endpoint’ы

```ts
if (path === '/api/proxy' && request.method === 'POST') {
  return handleTelegramProxy(request, env);
}

if (request.method === 'POST' && path === '/') {
  return handleTelegramProxy(request, env);
}
```

Комментарий говорит `redirect`, но код не перенаправляет запрос, а продолжает принимать его.

### Воздействие

Злоумышленник может:

- отправлять спам владельцу;
- расходовать Telegram API и Worker quota;
- отправлять документы;
- обходить ограничения frontend;
- использовать два дополнительных маршрута после удаления catalog POST.

### Инструкция по исправлению

1. Удалить маршруты `/api/proxy` и POST `/`.
2. Для неизвестных методов возвращать `405`, для неизвестных путей — `404`.
3. Оставить явные маршруты:
   - `GET /api/catalog`;
   - `POST /api/order`;
   - `POST /api/review`.
4. Подключить Turnstile к order и review.
5. Проверять Turnstile token на Worker.
6. Добавить Cloudflare WAF/Rate Limiting отдельно для order и review.
7. Настроить разумные лимиты:
   - order: например, несколько запросов с IP за час;
   - review: более строгий лимит;
   - отдельный burst limit.
8. Ограничить допустимый Origin сайта как дополнительный слой.
9. Не считать Origin/CORS самостоятельной авторизацией.
10. Добавить тесты на каждый удалённый legacy route.

### Acceptance criteria

- `/api/proxy` → 404 или 410.
- `POST /` → 404 или 405.
- Запрос без Turnstile → 403/400.
- Burst-запросы → 429.
- Запросы с другого Origin не обходят защиту.
- Ни один публичный endpoint не может вызвать Telegram бесконечное количество раз.

---

## BUG-01 / P1 — пустая форма заказа отправляется

**Статус:** ✅ Исправлено (`eb89760`). `novalidate` убран, добавлена своя валидация полей с сообщением у каждого поля, `aria-invalid`/`aria-describedby`, фокус на первой ошибке. Worker принимает структурированные поля (`validateOrder`) и собирает текст для Telegram сам; пустая форма получает 400 `{ status:'invalid', fields }`.

**Файл:** `order.html`, `scripts/order.js`, `worker/src/validators.ts`, `worker/src/index.ts`

### Проблема

Форма содержит:

```html
<form id="order-form" novalidate>
```

Но обработчик не вызывает `checkValidity()` и не реализует собственную field validation.

Обязательные поля:

```html
<input required>
<input required>
<textarea required minlength="10">
```

из-за `novalidate` не защищают submit.

### Подтверждение

Browser mock test с пустыми `name`, `contact` и `description`:

```text
POST-запросов: 1
URL: https://tg-proxy.metalkor91.workers.dev/api/order
```

### Инструкция по исправлению

Рекомендуемый вариант:

1. Убрать `novalidate`.
2. Перед submit выполнить `form.checkValidity()`.
3. Для контролируемого UX добавить свои inline errors:
   - `<p id="order-name-error">`;
   - `aria-describedby`;
   - `aria-invalid`;
   - фокус на первое ошибочное поле.
4. Не использовать только общий `alert()`.
5. На Worker отправлять и валидировать структурированные поля, а не только готовую Telegram-строку.
6. Сохранять отдельные лимиты на сервере, даже если HTML уже валидирует форму.

### Acceptance criteria

- Пустая форма не создаёт POST.
- Короткое описание не создаёт POST.
- Ошибка отображается возле конкретного поля.
- Клавиатурный пользователь переводится к первой ошибке.
- Прямая отправка плохого JSON на Worker получает 400.

---

## BUG-02 / P1 — partial file failure несовместим с клиентом

**Статус:** ✅ Исправлено (`eb89760`). Worker отдаёт `status: success | partial | rejected | unknown`, клиент обрабатывает каждое состояние отдельно: partial показывает номер заявки и кнопку «Прислать файлы в VK», вложения не очищаются, авто-retry отсутствует, ложного общего «Ошибка отправки» больше нет.

**Worker:** `worker/src/index.ts` — `handleOrder()` возвращает `status`.
**Client:** `scripts/order.js` — состояния success/partial/rejected/unknown/invalid/pending.

### Проблема

Worker при частичной ошибке возвращает HTTP 200:

```json
{
  "ok": false,
  "partial": true,
  "message": "Текст отправлен, но файл не доставлен..."
}
```

Клиент делает:

```js
if (!res.ok || data.ok !== true) {
  throw new Error(data.error || 'HTTP ' + res.status);
}
```

Поэтому `result.partial` недостижим.

### Подтверждение

Mock Worker response:

```text
HTTP 200 { ok:false, partial:true }
```

Фактический результат:

```text
Общий alert «Ошибка отправки»
Success-блок не показан
Форма осталась открытой
```

### Инструкция по исправлению

Зафиксировать единый контракт:

```json
{
  "status": "partial",
  "order": "260916-1234",
  "sentFiles": 2,
  "totalFiles": 3,
  "message": "Текст заявки отправлен, один файл не доставлен"
}
```

Разрешённые состояния:

```text
success  — текст и все файлы доставлены
partial  — текст доставлен, часть файлов нет
rejected — Telegram ничего не принял
unknown  — результат upstream неизвестен
```

Frontend должен:

1. Обрабатывать `status === 'partial'` отдельно.
2. Не показывать «Попробуйте ещё раз» после фактической доставки текста.
3. Не очищать вложения без определённого решения.
4. Показывать номер заявки.
5. Объяснять, как отправить недоставленные файлы через VK.

### Acceptance criteria

- Partial response показывает partial UI.
- Пользователь не получает ложную общую ошибку.
- Автоматический retry отсутствует.
- В Telegram и UI совпадает номер заявки.

---

## SEC-02 / P1 — idempotency неатомарна и необязательна

**Статус:** ✅ Исправлено (`ccd33e8` — атомарный DO-claim, `eb89760` — клиентская часть). Сетевой timeout больше не приводит к новому `request_id`: клиент хранит ID до терминального состояния, поэтому ручной повтор после ошибки не создаёт вторую заявку. При `409 pending` — авто-ретрай с тем же ID.

**Worker:** `worker/src/index.ts` (claim через `IdempotencyObject`).

**Client:** `scripts/order.js` — `state.requestId`.

### Проблемы

Сейчас последовательность такая:

```text
check KV
→ отправить Telegram
→ записать KV
```

Два параллельных запроса с одним ID оба могут пройти `check` и оба отправить сообщение.

Дополнительно:

- `request_id` необязателен;
- сервер не проверяет формат и размер ID;
- KV eventual consistency не гарантирует мгновенное чтение результата;
- после сетевого timeout frontend генерирует новый ID;
- `KV.put()` не отделён от состояния уже отправленного сообщения.

### Инструкция по исправлению

1. Сделать `request_id` обязательным.
2. Проверять формат UUID/строки и длину.
3. Не позволять пользовательскому тексту напрямую формировать бесконечно длинный KV key.
4. Перейти на Durable Object или D1 transaction для атомарного claim.
5. Создавать запись `pending` до отправки Telegram.
6. Хранить переходы:

```text
pending
message_sent
files_sent
partial
failed
unknown
```

7. Возвращать сохранённый результат для повторного ID.
8. Хранить один request ID на клиенте до терминального состояния.
9. Не генерировать новый ID при retry после сетевой ошибки.
10. Обрабатывать сбой записи состояния отдельно от сбоя Telegram.

### Acceptance criteria

- Два параллельных запроса с одним ID дают одно Telegram-событие.
- Повтор с тем же ID возвращает прежний результат.
- ID длиной 100000 символов отклоняется.
- Запрос без ID отклоняется.
- Сбой KV не создаёт незаметную возможность повторной доставки.

---

## SEC-03 / P1 — обход allowlist через пустой MIME

**Файл:** `worker/src/index.ts:183–193`.

### Проблема

```ts
if (file.type && !ALLOWED_TYPES.includes(file.type)) {
  return ...;
}
```

При пустом `file.type` проверка не выполняется. Можно передать произвольный файл с пустым MIME.

Это особенно важно для расширений, которые браузер часто отправляет как `application/octet-stream` или пустую строку:

```text
.stl .obj .3mf .step .stp .igs .iges .dwg .f3d .zip .rar
```

Часть этих форматов сейчас разрешена в HTML, но отклоняется Worker’ом, а часть неизвестных файлов может пройти из-за пустого MIME.

### Инструкция по исправлению

1. Составить официальный список форматов.
2. Проверять расширение после нормализации имени.
3. Проверять MIME, если он присутствует.
4. Для `application/octet-stream` разрешать только расширения из явного allowlist.
5. Не пропускать неизвестный MIME без проверки расширения.
6. Ограничить длину имени файла.
7. Нормализовать имя до передачи в Telegram.
8. Не выполнять и не распаковывать пользовательские файлы на Worker.
9. Синхронизировать список с `accept`.

### Acceptance criteria

- Разрешённые STL/OBJ/PDF проходят.
- Неизвестный `.exe` отклоняется даже с пустым MIME.
- `application/octet-stream` проходит только для разрешённого расширения.
- Клиент и Worker дают одинаковый результат.

---

## SEC-04 / P1 — multipart разбирается до ограничения полного body

**Статус:** ✅ Исправлено (commit `442c73e`). Добавлена проверка `Content-Length` до `formData()` через `MAX_MULTIPART_BODY` (50 МБ).

**Файлы:** `worker/src/index.ts` — проверка в `handleOrder()` перед `request.formData()`.

### Проблема

Для JSON проверяется `Content-Length`, но multipart сразу разбирается:

```ts
const form = await request.formData();
```

до проверки полного body.

Лимит суммы файлов не ограничивает:

- количество дополнительных multipart-полей;
- размер имён файлов;
- размер служебных частей multipart;
- body без `Content-Length`;
- данные, которые уже были материализованы в памяти.

### Инструкция по исправлению

1. Проверять `Content-Length` до `formData()`, если заголовок доступен.
2. Ввести общий multipart limit с запасом для multipart overhead.
3. Ограничить количество полей.
4. Ограничить длины `text`, `request_id`, `honeypot` до разбора или сразу после контролируемого чтения.
5. Рассмотреть stream/arrayBuffer cap, если это соответствует Cloudflare Workers API.
6. Проверить chunked request без `Content-Length`.
7. Не полагаться только на client-side 40 MB limit.

### Acceptance criteria

- Multipart больше серверного лимита получает 413.
- Огромный запрос не доходит до Telegram.
- Запрос с большим количеством дополнительных полей отклоняется.
- Лимиты client/server документированы одним контрактом.

---

## REL-01 / P1 — Telegram fetch без timeout и безопасного разбора ответа

**Статус:** 🔧 Частично исправлено (commit `442c73e`). Вынесен `sendDocument()` helper, structured logging. Timeout и AbortController — открыты.

**Файлы:** `worker/src/index.ts` — `sendDocument()` и `sendMessage()` как отдельные функции.

### Проблемы

Нет:

- `AbortController`/`AbortSignal.timeout`;
- проверки HTTP status до `res.json()`;
- безопасного поведения при HTML/non-JSON ответе;
- единой классификации Telegram/network/timeout ошибок.

`sendDocument` вызывается последовательно для каждого файла. При зависании downstream один multipart-запрос может долго занимать Worker, а пять файлов увеличивают время ожидания.

### Инструкция по исправлению

Вынести Telegram-вызовы в модуль:

```text
telegramFetch()
sendMessage()
sendDocument()
```

Внутри:

1. установить timeout на каждый upstream request;
2. проверять HTTP status;
3. безопасно читать JSON;
4. возвращать типизированный результат;
5. различать `timeout`, `network`, `telegram_rejected`, `unknown`;
6. не ретраить автоматически после неизвестного результата;
7. логировать только request ID, order ID и тип ошибки;
8. никогда не логировать BOT_TOKEN и пользовательские документы.

---

## DATA-01 / P1 — runtime-валидация каталога отсутствует на Worker

**Worker:** `worker/src/index.ts:85–95`.

**Client:** `scripts/catalog.js:36–49, 229–242`.

### Проблема

Worker делает `JSON.parse` и возвращает результат без схемы. TypeScript-интерфейс внизу файла не проверяет данные во время выполнения.

Клиент частично валидирует элементы, но:

- не проверяет, что `data.items` — массив;
- требует `description` как строку, хотя документация делает поле необязательным;
- не проверяет уникальность ID;
- не ограничивает размер ответа;
- может вызвать `.filter()` на неподходящем типе.

### Инструкция по исправлению

Создать валидатор catalog payload:

```text
validateCatalogPayload(raw)
validateCatalogItem(item)
```

Проверять:

- объект верхнего уровня;
- массив `items`;
- максимум элементов;
- уникальные целочисленные ID;
- длину name/description/material/price;
- `category: techno | decor`;
- безопасный относительный image path;
- отсутствие неизвестных критических полей;
- общий размер сериализованного каталога.

На клиенте:

```js
var items = data && Array.isArray(data.items) ? data.items : [];
```

Повреждённая запись не должна ломать весь каталог.

---

## BUG-03 / P2 — корректный JSON `null` даёт 500

**Статус:** ✅ Исправлено (commit `442c73e`). Добавлена `parseJsonObject()`, отвергающая `null`/`[]`/строки с 400.

**Файлы:** `worker/src/index.ts` — новая функция `parseJsonObject()`.

### Проблема

`request.json()` успешно разбирает `null`, после чего код делает обращение к `body.honeypot`.

Live-результат:

```text
POST /api/order body=null → 500 Internal error
POST /api/review body=null → 500 Internal error
```

### Инструкция

Создать общий `parseJsonObject()` и отклонять не-объекты с `400`:

```text
null
[]
"text"
123
```

Проверять также Content-Type и размер body.

---

## UX-01 / P1 — review success показывается при ошибке

**Файл:** `reviews.html:357–405`.

### Проблема

Форма скрывается и success показывает независимо от результата `fetch`.

При `HTTP 500` browser mock подтвердил:

```text
successVisible: block
formVisible: none
```

### Инструкция

1. Сделать обработчик `async`.
2. Ожидать `fetch`.
3. Проверять `res.ok` и `result.ok === true`.
4. Только после успешного результата скрывать форму.
5. При ошибке оставить значения полей.
6. Показывать inline error с `aria-live="polite"`.
7. Добавить disabled/loading state.
8. Не использовать только `console.error`.

---

## UX-02 / P1 — двойной submit отзывов

**Файл:** `reviews.html:357–405`.

### Проблема

У review-формы нет `isSubmitting`, disabled и idempotency. Два submit создают два POST.

### Инструкция

1. Добавить `isSubmitting`.
2. Блокировать submit button после начала запроса.
3. Добавить `aria-busy="true"`.
4. Возвращать кнопку в исходное состояние только после завершения.
5. Добавить request ID.
6. Добавить server-side rate limit.

---

## UX-03 / P2 — пустой каталог отображается как загрузка

**Файл:** `scripts/catalog.js:59–61`.

### Проблема

Ответ `items: []` вызывает постоянный текст:

```text
Каталог загружается…
```

### Инструкция

Разделить render states:

```text
loading
empty
error
success
```

Для `empty` использовать:

```text
Пока нет опубликованных работ.
```

Для `error` добавить кнопку retry с timeout/AbortController.

---

## UX-04 / P3 — HTML-entities в тексте отзыва доходят до Telegram как есть

**Источник:** найдено при работе над этапом 4 (2026-09-17), перенесено в этап 5.

**Файл:** `worker/src/index.ts` — `handleReview()`.

### Проблема

Имя и текст отзыва прогоняются через `esc()` (`&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;`), но `sendMessage()` вызывается **без** `parse_mode`. В этом режиме Telegram HTML не разбирает, поэтому в чате видны буквальные сущности. Пример: отзыв «деталь 5×5 & крепления» приходит как «деталь 5×5 `&amp;` крепления».

Дополнительно: сообщение заявки (`handleOrder()`, этап 4) собирается **без** экранирования — то есть order и review сегодня ведут себя по-разному.

### Инструкция по исправлению (этап 5)

1. **Предпочтительно:** убрать `esc()` и оставить `sendMessage()` без `parse_mode` — текст уходит как есть; инъекции нет, потому что HTML не парсится. Поведение order и review становится одинаковым.
2. Альтернатива: добавить `parse_mode: 'HTML'` в `sendMessage()` — тогда экранирование обязательно для **обоих** сообщений (order тоже), иначе сообщение с `<` будет отклонено Telegram с 400.

### Acceptance criteria

- Отзыв с символами `&`, `<`, `>` приходит в Telegram в исходном виде.
- Order и review ведут себя одинаково.
- Автотест в `worker/tests/run-tests.js`: mock Telegram получает текст с этими символами без изменений.

---

# 5. Accessibility, UX и performance

## A11Y-01 — звёзды не имеют корректного radio state

**Файл:** `reviews.html:267–275, 305–344`.

Сейчас все `.star` получают `tabindex="0"` и `role="radio"`, но отсутствует:

- `aria-checked`;
- roving tabindex;
- `aria-required`;
- корректное начальное состояние.

### Исправление

Предпочтительно использовать настоящие buttons:

```html
<button type="button" role="radio" aria-checked="false">★</button>
```

При выборе:

- выбранной звезде `aria-checked="true"`;
- остальным `false`;
- только одной звезде `tabindex="0"`;
- остальным `tabindex="-1"`;
- стрелками менять выбранное значение.

---

## A11Y-02 — lightbox открывается только мышью

**Файл:** `scripts/catalog.js:75–83, 179–190`.

Клик обработан на `<img>`, но нет keyboard-trigger.

### Исправление

Использовать `<button>` вокруг изображения либо добавить полноценную keyboard semantics:

- Enter/Space;
- `aria-label`;
- `:focus-visible`;
- возврат focus после закрытия;
- `inert` фонового содержимого.

---

## A11Y-03 — mobile menu требует полного focus management

**Файл:** `scripts/common.js:27–61`.

Возврат фокуса добавлен, но отсутствуют `aria-controls`, focus trap и управление фоновой частью страницы.

### Исправление

Добавить:

- `aria-controls`;
- `aria-expanded`;
- `aria-hidden`;
- focus trap;
- Escape;
- возврат focus;
- `inert` или эквивалент для background.

---

## A11Y-04 — review FAB не описывает состояние

**Файл:** `reviews.html:253–258, 346–355`.

Добавить:

```html
<button
  type="button"
  aria-expanded="false"
  aria-controls="review-panel"
>
```

При открытии менять `aria-expanded`, переводить focus в панель и возвращать его при закрытии.

Не полагаться на CSS `:hover` как на единственный способ открыть panel.

---

## A11Y-05 — декоративные SVG

**Файлы:** `index.html:41`, `works.html:73` и другие SVG.

Для декоративных изображений добавить:

```html
aria-hidden="true"
```

Если SVG несёт смысл, добавить понятный accessible name.

---

## PERF-01 — каталоговые изображения без width/height

**Файл:** `scripts/catalog.js:78–83`.

Изображения создаются без атрибутов размеров. `aspect-ratio` контейнера снижает риск layout shift, но не заменяет intrinsic dimensions.

### Исправление

1. Добавить размеры в catalog data.
2. Или использовать стабильный ratio 4:3.
3. Устанавливать `width` и `height` на `<img>`.
4. Сохранить `loading="lazy"`.
5. Добавить `decoding="async"`.

---

## PERF-02 — отсутствует timeout каталога

**Файл:** `scripts/catalog.js:223–243`.

Если Worker зависнет, страница может долго оставаться в loading state.

### Исправление

Использовать `AbortController`/timeout и retry button.

---

## CSS-01 — `transition: all`

**Файлы:** `styles/main.css` и inline CSS `reviews.html`.

Заменить `transition: all` на конкретные свойства:

```css
transition:
  transform .25s ease,
  opacity .25s ease,
  box-shadow .25s ease;
```

Проверить transitions:

- карточек;
- кнопок;
- FAB;
- review panel;
- form controls;
- lightbox.

---

## CSS-02 — подозрительный `font-weight`

**Файл:** `styles/main.css:306`.

```css
.mat-hint strong {
  font-weight: 60;
}
```

Проверить, что должно быть `600`, и добавить CSS validation.

Также исправить двойную точку с запятой в `styles/main.css:338`.

---

## CSS-03 — mobile safe areas и theme color

Добавить на страницы:

```html
<meta name="theme-color" content="#09090b">
```

Для fixed-кнопок учитывать:

```css
padding-bottom: calc(20px + env(safe-area-inset-bottom));
padding-right: calc(20px + env(safe-area-inset-right));
```

---

## HTML-01 — поле «Телефон или Telegram»

**Файл:** `order.html:48–50`.

`type="tel"` неудобен для `@username`.

Рекомендуемые варианты:

1. разделить телефон и Telegram;
2. использовать `type="text"` + `inputmode="text"`;
3. оставить единое поле, но явно описать оба допустимых формата и валидировать их на сервере.

---

## HTML-02 — placeholders

В проекте встречаются строки с `...`:

```text
+7 ... или @username
```

Согласно Web Interface Guidelines лучше использовать `…` и понятный пример:

```text
+7 900 123-45-67 или @username
```

---

# 6. Python-инструменты

## PY-01 / P2 — `figure_from_ai.py` падает на пустой маске

**Файл:** `tools/figure_from_ai.py:205–221`.

Безопасный тест на полностью чёрной картинке дал:

```text
метод: otsu, ratio 0.00, площадь 0.0%
ZeroDivisionError: division by zero
```

Проблема возникает до проверки `h == 0`:

```python
x, y, w, h = cv2.boundingRect(mask)
scale = args.height / h
```

### Исправление

До вычисления масштаба проверять:

- mask не пустая;
- `w > 0`;
- `h > 0`;
- площадь выше минимального порога;
- aspect в допустимом диапазоне.

Возвращать понятный `SystemExit` без traceback для CLI-пользователя.

### Тесты

- полностью чёрное изображение;
- полностью белое изображение;
- маленькая точка;
- прозрачный PNG;
- RGB/RGBA;
- повреждённый файл;
- изображение с пустой директорией output.

---

## PY-02 / P2 — output directories создаются не всеми tools

**Файлы:**

- `tools/figure_from_ai.py:40–47, 242–248`;
- `tools/ai_repaint.py:75–81`.

`figure_cutout.py` и `figure_hero.py` создают директории, а другие инструменты могут упасть при новом пути output/preview.

### Исправление

Вынести общую функцию:

```python
def ensure_parent_dir(path):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
```

Использовать её для:

- output;
- preview;
- preview-light;
- debug files.

Добавить проверки `height`, `width`, `quality`, `erode`, `pad`, `steps`, `strength`.

---

## PY-03 / P3 — falsy trap в `figure_hero.py`

**Файл:** `tools/figure_hero.py:336, 355`.

Сейчас используется:

```python
axis or find_axis(...)
```

При `--axis 0` будет выполнен авто-расчёт, хотя пользователь явно передал значение.

### Исправление

Использовать:

```python
axis if axis is not None else find_axis(...)
```

Добавить диапазонную проверку axis.

---

## PY-04 / P3 — `edge_report.py` зависит от отсутствующих tmp-файлов

**Файл:** `tools/edge_report.py:44–48`.

Скрипт жёстко ожидает:

```text
tmp/old-asset-s2.webp
tmp/old-asset-v1.webp
```

Они исключены из обычного tracked набора и могут отсутствовать после чистого clone.

### Исправление

1. Добавить аргументы `--old`, `--new`, `--review-dir`.
2. Проверять наличие файлов до чтения.
3. Возвращать понятное сообщение.
4. Не использовать абсолютный путь `C:\Users\metal\web-sites\_review-3dprint` как единственный default.

---

# 7. Документация и конфигурация

## DOC-01 — README предлагает запрещённый внешний image URL

**Файл:** `README.md:43–48`.

README предлагает загрузить изображение на Imgur и вставить Direct link.

Но Worker `isSafeImageUrl()` разрешает только относительные пути:

```text
images/...
```

Абсолютные `http://` и `https://` блокируются.

### Исправление

Для текущей архитектуры рекомендовать только:

1. положить изображение в `images/`;
2. закоммитить его;
3. указать относительный путь в каталоге;
4. обновить KV через безопасный seed/admin workflow.

Если нужен CDN, сначала реализовать allowlist доменов и отдельные тесты.

---

## DOC-02 — README содержит нерабочую seed-команду

**Файл:** `README.md:8–18`.

```bash
node seed-catalog.js
```

только печатает JSON и не записывает его в KV.

Рабочая команда указана в комментарии `worker/seed-catalog.js:2`:

```bash
cd worker
npx wrangler kv key put \
  --binding CATALOG_KV \
  --key catalog \
  "$(node seed-catalog.js)"
```

### Исправление

Обновить README:

- добавить `cd worker`;
- привести реальную команду;
- описать test/prod namespace;
- после записи выполнять `GET /api/catalog`;
- добавить rollback-процедуру.

---

## DOC-03 — `.env.example` устарел

**Файл:** `.env.example`.

В нём остались Google Sheets и Tally, которые не соответствуют текущей архитектуре. Отсутствуют актуальные переменные локального AI-пайплайна:

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
```

### Исправление

Разделить:

- `.env.example` для локальных Python tools;
- Cloudflare Worker secrets;
- deploy credentials.

Никогда не помещать реальные секреты в репозиторий.

---

## DOC-04 — wiki не соответствует текущему Worker

**Файл:** `C:\Users\metal\wiki\3D-печать.md:267–307, 379–383, 530–556`.

Остались противоречия:

- публичный POST catalog описан как рабочий;
- одновременно каталог описан как KV-only read API;
- встречается старая схема Telegram → imgbb → GitHub;
- в структуре файлов каталог всё ещё описан как встроенный в JS;
- checklist старого ревью не отражает открытые partial findings.

### Исправление

После завершения кода синхронизировать wiki с фактическим состоянием:

```text
GET /api/catalog — public
catalog write — dashboard/wrangler/admin-only
POST /api/order — protected public form
POST /api/review — protected public form
legacy routes — removed
```

---

# 8. План исправлений по этапам

## Этап 0 — зафиксировать baseline

Перед исправлениями:

1. Создать отдельную ветку.
2. Сохранить чистый baseline `5a9bb2b`.
3. Не использовать production Telegram chat для тестов.
4. Создать test KV namespace.
5. Завести mock Telegram API либо отдельный test chat.
6. Сохранить текущие smoke-команды.
7. Проверить историю на секреты.

Каждый завершённый этап должен иметь отдельный commit и push.

## Этап 1 — закрыть поверхность Worker

1. Удалить `/api/proxy`.
2. Удалить POST `/`.
3. Оставить только явные маршруты.
4. Добавить method handling.
5. Добавить Turnstile.
6. Добавить rate limit.
7. Ограничить Origin как дополнительную защиту.
8. Добавить structured logging.
9. Разделить client error/upstream error/internal error.

## Этап 2 — единый input contract

Создать валидаторы для:

- order;
- review;
- catalog;
- request ID;
- files.

Требования:

- object shape;
- string lengths;
- enum values;
- numeric ranges;
- body limits;
- file extension/MIME;
- no unknown oversized values;
- predictable 4xx responses.

## Этап 3 — idempotency и состояние доставки

1. Выбрать Durable Object или D1.
2. Атомарно claim request ID.
3. Хранить state machine.
4. Использовать одинаковый request ID при retry.
5. Не повторять неопределённую upstream-операцию автоматически.
6. Добавлять order ID к каждому документу.

## Этап 4 — order form

**Статус:** ✅ выполнено (`eb89760`): `scripts/order.js` + структурированные поля на Worker + состояния `success/partial/rejected/unknown/invalid` + тесты `worker/tests/run-tests.js` (76/76).

Вынести inline script из `order.html` в `scripts/order.js`.

Сконцентрировать там:

- state формы;
- attachment state;
- client validation;
- `clearAttachments()`;
- `isSubmitting`;
- request ID;
- loading/error/success/partial states;
- retry policy;
- `aria-live`.

## Этап 5 — review form

**Статус:** ⏳ следующий шаг (не начат).

Вынести inline review logic в `scripts/review-form.js`.

Исправить:

- ожидание ответа Worker (сейчас «спасибо» показывается, не дождавшись ответа — UX-01);
- false success;
- double submit (UX-02);
- request ID (UUID v4 — контракт этапа 2);
- server-side rate limit уже есть (KV per-IP, 3/ч → 429) — нужна клиентская обработка 429;
- aria state stars (A11Y-01), focus management FAB/panel (A11Y-03, A11Y-04);
- **UX-04 (перенесено с этапа 4):** убрать `esc()` при `sendMessage()` без `parse_mode` — иначе в Telegram видно `&amp;`; заодно выровнять поведение order и review;
- автотесты на новый контракт в `worker/tests/run-tests.js` (по образцу этапа 4).

## Этап 6 — catalog и lightbox

1. Валидировать payload на Worker.
2. Валидировать payload на клиенте.
3. Разделить loading/empty/error/success.
4. Добавить timeout/retry.
5. Добавить `width`/`height` изображениям.
6. Сделать image trigger клавиатурным.
7. Доработать dialog focus/inert.
8. Сохранить DOM API для данных из KV.

## Этап 7 — accessibility и performance

1. Убрать `transition: all`.
2. Добавить `theme-color`.
3. Добавить Google Fonts preconnect.
4. Добавить safe area insets.
5. Исправить stars radio semantics.
6. Исправить drawer ARIA/focus.
7. Добавить `aria-hidden` декоративным SVG.
8. Проверить 375/1920 и keyboard-only сценарий.

## Этап 8 — Python tools

1. Обработать пустые маски.
2. Создавать output directories.
3. Добавить validation CLI arguments.
4. Исправить `axis if axis is not None`.
5. Убрать жёсткие пути.
6. Добавить fixtures и тесты.

## Этап 9 — документация

1. Исправить README seed workflow.
2. Убрать неправильную Imgur-инструкцию.
3. Обновить `.env.example`.
4. Обновить deployment guide.
5. Синхронизировать wiki.
6. В предыдущем отчёте пометить partial/open findings честно.

## Этап 10 — deploy и rollback

Порядок:

1. Worker test namespace.
2. Worker unit/integration tests.
3. Test Telegram chat/mock.
4. Production Worker.
5. Live safe smoke.
6. GitHub Pages.
7. Browser 375/1920.
8. Cloudflare logs.
9. README/wiki.
10. Проверить `git log origin/main -1`.
11. Сохранить rollback commit и предыдущий Worker version ID.

---

# 9. Обязательный тестовый план

## 9.1 Worker/API

- [ ] `GET /api/catalog` → 200 и валидный payload.
- [ ] `POST /api/catalog` → 405.
- [ ] `/api/proxy` → 404/410.
- [ ] `POST /` → 404/405.
- [ ] malformed JSON → 400.
- [ ] JSON `null` → 400.
- [ ] JSON array → 400.
- [ ] JSON больше лимита → 413.
- [ ] multipart больше лимита → 413.
- [ ] слишком много multipart fields → 413/400.
- [ ] invalid file extension → 415.
- [ ] empty MIME + `.exe` → 415.
- [ ] allowed `.stl`/`.obj` → accepted if included in contract.
- [ ] invalid request ID → 400.
- [ ] missing request ID → 400, если contract делает его обязательным.
- [ ] duplicate request ID → один Telegram result.
- [ ] parallel duplicate request ID → один Telegram result.
- [ ] KV failure после Telegram success → состояние не теряется.
- [ ] Telegram timeout → bounded response.
- [ ] Telegram non-JSON → не 1101/не необработанный traceback.
- [ ] burst requests → 429.
- [ ] missing Turnstile → 403/400.

## 9.2 Browser order

- [ ] пустая форма не отправляет POST;
- [ ] каждая ошибка отображается возле поля;
- [ ] focus переводится к первой ошибке;
- [ ] один submit → один POST;
- [ ] двойной submit → один POST;
- [ ] полный success очищает attachments;
- [ ] обычная ошибка сохраняет введённые данные;
- [ ] partial response показывает partial UI;
- [ ] unknown response не запускает автоматический retry;
- [ ] retry использует тот же request ID;
- [ ] honeypot не объявляет ложный success screen reader’у;
- [ ] 375 px без overflow;
- [ ] 1920 px без overflow.

## 9.3 Browser reviews

- [ ] HTTP 200 + `ok:true` → success;
- [ ] HTTP 400/500 → error, форма остаётся;
- [ ] network error → error, форма остаётся;
- [ ] двойной submit → один POST;
- [ ] rating имеет `aria-checked`;
- [ ] stars работают с Tab/Arrow/Enter/Space;
- [ ] FAB имеет `aria-expanded`;
- [ ] panel закрывается Escape;
- [ ] focus возвращается на FAB.

## 9.4 Catalog/lightbox

- [ ] malformed catalog не ломает страницу;
- [ ] `items` не массив → controlled empty/error;
- [ ] пустой каталог не показывает вечную загрузку;
- [ ] retry после network timeout;
- [ ] image trigger работает клавиатурой;
- [ ] focus возвращается после lightbox;
- [ ] фон недоступен при открытом dialog;
- [ ] изображения имеют размеры;
- [ ] malicious image path не становится executable URL.

## 9.5 Python

- [ ] `python -m compileall -q tools`;
- [ ] empty image → понятная ошибка, не ZeroDivisionError;
- [ ] corrupted image → понятная ошибка;
- [ ] missing output directory создаётся;
- [ ] Unicode input path работает;
- [ ] `--axis 0` сохраняет значение 0;
- [ ] invalid dimensions rejected;
- [ ] `figure_check.py` PASS для production asset;
- [ ] bad asset → exit code != 0.

## 9.6 Static quality gates

- [ ] `node --check` для всех JS;
- [ ] TypeScript typecheck Worker;
- [ ] `wrangler deploy --dry-run`;
- [ ] HTML validation;
- [ ] CSS validation;
- [ ] secret scan;
- [ ] dependency audit;
- [ ] `git diff --check`;
- [ ] browser console без новых ошибок;
- [ ] live commit/asset versions проверены.

---

# 10. Что нельзя делать при исправлении

- Не считать CORS механизмом авторизации.
- Не оставлять legacy endpoint’ы «на всякий случай».
- Не использовать `localStorage` как server-side rate limit.
- Не принимать пустой MIME без проверки расширения.
- Не вызывать `request.formData()` до ограничения multipart body.
- Не считать TypeScript interface runtime validation.
- Не показывать success до подтверждённого `result.ok === true`.
- Не делать retry после неизвестного Telegram результата с новым request ID.
- Не хранить admin token во frontend.
- Не отправлять тесты в production Telegram chat.
- Не менять несколько независимых подсистем одним неразделённым коммитом.
- Не считать green syntax-check доказательством безопасности.

---

# 11. Рекомендуемые milestone-коммиты

```text
security(worker): remove legacy proxy routes and add abuse protection
security(worker): validate request bodies and multipart contract
security(worker): make idempotency atomic and validate request ids
fix(order): validate fields and handle partial delivery states
fix(reviews): await submission and prevent duplicate requests
fix(catalog): validate payload and separate loading empty error states
fix(a11y): keyboard lightbox, drawer focus, rating semantics
fix(tools): handle empty masks and output directories
perf(css): remove transition-all and stabilize image layout
docs(review): synchronize README and wiki with production architecture
```

Каждый commit должен пройти соответствующий раздел тестового плана, быть запушен в `origin/main`, после чего нужно проверить:

```bash
git log --oneline origin/main -1
git status --short --branch
```

---

# 12. Финальный acceptance criteria

Проект можно считать исправленным только если одновременно выполнены все условия:

1. Публичные legacy endpoint’ы удалены.
2. Telegram proxy имеет server-side abuse protection.
3. Невалидная форма не создаёт POST.
4. Partial delivery корректно отображается пользователю.
5. Idempotency атомарна и повторяемая.
6. Файлы валидируются по согласованному расширению/MIME/размеру.
7. Multipart body ограничивается до полной материализации.
8. Telegram upstream имеет timeout и безопасную обработку ответа.
9. Каталог проходит runtime schema validation.
10. Review success показывается только после подтверждённого успеха.
11. Lightbox, stars и mobile menu доступны с клавиатуры.
12. Python tools не падают на пустых/повреждённых входах.
13. README и wiki соответствуют фактической архитектуре.
14. Тесты проходят без использования production Telegram chat.
15. Production smoke и browser checks выполнены на 375 и 1920 px.
16. Worker и Pages задеплоены в правильном порядке.
17. Live origin и commit проверены после push.

---

## Вывод

Предыдущая серия исправлений была полезной, но её checklist завысил степень готовности. Сначала нужно закрыть Worker security и контракт доставки заявок, затем исправить frontend state management, после этого провести accessibility/performance и Python cleanup. Только после прохождения acceptance criteria сайт можно считать готовым к дальнейшей публичной эксплуатации.
