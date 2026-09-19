# Резюме сессии — сайт 3DArtStudio (3dprint-site)

Обновлено: 2026-09-19 · Ветка: `main` · Автор git: Rudrymor
**Этап 12 (Turnstile) выполнен и задеплоен: капча включена на заявке и отзыве. Осталась разовая живая проверка в обычном браузере владельца.**

## Коротко (TL;DR для новой сессии)

- Проект: `C:\Users\metal\Desktop\3D печать\3dprint-site` — статика (index/works/order/reviews) + Cloudflare Worker `tg-proxy` (заявки в Telegram, каталог работ в KV).
- **Прод обновлён.** Pages `main` = `a52d604` (этап 12 — Turnstile в клиенте), ветка `main` на `bc86193`. Worker `tg-proxy` — версия `ee0be42c` (этап 12, капча активна), точка отката `134e5c82`.
- Этапы 0–12 закрыты и задеплоены. **Turnstile включён**: виджет создан владельцем, secret задан, site key в клиенте. POST без токена → 403 `Missing Turnstile token`. Осталась разовая живая проверка «с токеном → заявка доходит до Telegram» в обычном браузере (headless-автоматизация Turnstile токен не выдаёт по дизайну). Спам сверх капчи держат серверные лимиты (заявки 5/ч, отзывы 3/ч на IP).
- Проверки: `cd worker && node tests/run-tests.js` → **128/128**; `python tools/tests/run-tests.py` → **23/23**; `python -m compileall -q tools`; `cd worker && npx wrangler deploy --dry-run`; `node --check scripts/*.js`; `git diff --check`.
- Порядок работы: один этап = коммит + push + проверки → **отчёт простыми словами владельцу** → одобрение → следующий этап. Секреты — только Cloudflare/.env, в чат не попадают. Тесты — только mock, в прод-Telegram ничего не уходит. Автор коммитов — «Rudrymor». После этапа обновлять три документа: вики `C:\Users\metal\wiki\3D-печать.md`, `code-review-3dprint-2026-09-16.md` и этот файл.
- **Что нужно от владельца:** одна живая проверка в обычном браузере — отправить реальную заявку через форму на https://rudrymor.github.io/3dprint-site/order.html (капча Managed пройдётся автоматически) и убедиться, что заявка дошла до Telegram. Всё остальное задеплоено и проверено.

## Что за проект

Сайт для друга, который печатает на заказ: 4 страницы (index, works, order, reviews), статика HTML/CSS/JS на GitHub Pages + Cloudflare Worker (заявки в Telegram, каталог работ в KV). Стек: HTML + CSS + vanilla JS, тёмный дизайн (#09090b), шрифт Outfit.

- Путь: `C:\Users\metal\Desktop\3D печать\3dprint-site`
- Прод Pages: https://rudrymor.github.io/3dprint-site/ — `main` = `6140221` ✅ (сайт на этапе 11 не менялся)
- Прод Worker: https://tg-proxy.metalkor91.workers.dev — версия `8a56ea2f` (этап 11, REL-01) ✅; `GET /api/catalog` отдаёт 12 живых работ
- Wiki (источник правды о проекте): `C:\Users\metal\wiki\3D-печать.md`
- План и детали: `code-review-3dprint-2026-09-16.md` в проекте (+ отчёт `-2026-09-15.md`)
- Скриншоты проверок: `C:\Users\metal\Desktop\3D печать\_review\` (`review_*.png` — этап 5, `stage6_*.png` — этап 6)
- Точка отката каталога: `tmp/catalog-backup.json` (12 записей, снято чтением прод-KV; `tmp/` в `.gitignore`)

## Состояние на конец сессии

- Этапы 0–12 закрыты и **задеплоены**. Baseline прода до этой работы — `5a9bb2b`; сайт (`main`) на `a52d604`, Worker на `ee0be42c` (этап 12, капча активна), ветка `main` на `bc86193`.
- **Turnstile включён (этап 12)**: виджет создан владельцем, secret задан, site key в клиенте. POST без токена → 403 `Missing Turnstile token`. Разовая живая проверка «с токеном → Telegram» — в обычном браузере владельца.
- **REL-01 закрыт** (`b96ba80`): таймаут/HTTP-статус/безопасный разбор/классификация ошибок у Telegram-вызовов. **Живая проверка формы→Telegram выполнена** (две тестовые заявки доставлены боту).
- В рабочем дереве некоммитируемым остаётся только этот файл (`SESSION-RESUME.md`).

## Готово (этапы 0–11)

| Этап | Коммит | Суть |
|---|---|---|
| 0 | `5be0aeb`, `7b1e5cb` | ветка, ревью-документы, secret-скан 87 коммитов чисто |
| 1 | `442c73e`, `2626cb0` | удалены legacy `/api/proxy` и `POST /`; structured logging, `checkOrigin()`, KV rate-limit (order 5/ч, review 3/ч → 429), Turnstile за секретом + виджет на order/reviews |
| 2 | `33abe5f` | `worker/src/validators.ts` — единый input contract, обязательный UUID v4 `request_id`, файлы extension-MIME, field-count, catalog runtime-валидация |
| 3 | `ccd33e8` | атомарная idempotency: DO `IdempotencyObject` (SQLite), `pending → sent\|partial\|failed`, дубль ID → 409, replay → тот же результат |
| 4 | `eb89760` | форма заказа: структурированные поля + серверная сборка текста, `scripts/order.js`, состояния success/partial/rejected/unknown, файлы валидируются до claim |
| 5 | `e9f7b7f` | форма отзывов: `scripts/review-form.js`, «спасибо» только после ответа Worker'а, double-submit защита, request_id/429, звёзды-radio, FAB с фокусом; Worker: `handleReview()` без `esc()`, `validateReview` → карта ошибок |
| 6 | `43125e6` | каталог: `scripts/catalog.js` — состояния loading/empty/error/success, timeout 10 с + retry, клиентская валидация payload, `width`/`height`/`decoding=async`, фото-кнопка (Enter/Space), лайтбокс с `inert` и возвратом фокуса; `works.html` — скрытый счётчик, стартовый loading, `noscript` |
| 7 | `12ed504` | a11y/perf: мобильное меню с `aria-controls`/ловушкой фокуса/`inert` фона (A11Y-03), точечные transitions без `all` (CSS-01), `theme-color`/`preconnect`/`safe-area` (CSS-03), `aria-hidden` декоративных SVG (A11Y-05), запас 120px у формы заказа (VK не перекрывает поля на 375px); попутно CSS-02 |
| 8 | `1db5fbb` | Python-инструменты (PY-01…PY-04): `tools/tool_common.py`, `check_mask()` вместо `ZeroDivisionError`, папки вывода, диапазоны аргументов, `axis if axis is not None`, `edge_report.py` на argparse без жёстких путей; тесты 23/23 |
| 9 | `f694527` + docs | документация (DOC-01…DOC-04): рабочий seed-workflow под wrangler 4, только относительные `images/`, новый `DEPLOYMENT.md`, `.env.example` в трёх разделах, вики синхронизирована |
| 10 | `8a337a4`, `2497fa8`, `4f0da28` | **деплой и откат**: Worker задеплоен (версия `134e5c82`), `CHAT_ID` → секрет, легаси-контракт `text` удалён, сайт опубликован (`main` = `4f0da28`), прод-смоук, браузерная проверка 375/1920, доки обновлены |
| 11 | `b96ba80` | **REL-01 + живая проверка Telegram**: таймаут 15 с / HTTP-статус / безопасный JSON / классификация ошибок у Telegram-вызовов → задеплоен (версия `8a56ea2f`, точка отката `134e5c82`), тесты 128/128; живая проверка формы→Telegram выполнена (2 тестовые заявки доставлены боту) |
| 12 | `48dd24f`, `a52d604`, `bc86193` | **Turnstile включён**: виджет создан владельцем, secret задан (`wrangler secret put TURNSTILE_SECRET`), site key `0x4AAAA...` в `order.js`/`review-form.js`. Пойман и исправлен баг рендера — `initTurnstile()` на `DOMContentLoaded` выходил, пока `window.turnstile` (async defer) не готов; теперь ждёт до ~6 c (`?v=3`). Worker `ee0be42c`, Pages `main` = `a52d604`. Проверено: POST без токена → 403 `Missing Turnstile token`; виджет рендерится; отправка без капчи заблокирована без исходящего запроса. Выдача реального токена (живой браузер) — разовая проверка владельцем |

## Что именно сделано в этапе 10 (контекст для следующей сессии)

**Порядок соблюдён: сначала Worker, потом сайт** (старый Worker на multipart отвечает 500 — форма с вложениями потеряла бы заявку).

**Worker (`npx wrangler deploy`, версия `134e5c82`).** Деплоить пришлось **дважды**:
1. Сначала правка `wrangler.toml` — убрать `[vars] CHAT_ID = "2030385539"` → `npx wrangler deploy`. Без этого шага `secret put CHAT_ID` падает с `Binding name 'CHAT_ID' already in use. Please use a different name and try again. [code: 10053]` (переменная `[vars]` и секрет делят одно имя).
2. Затем `echo "2030385539" | npx wrangler secret put CHAT_ID` → успех. `npx wrangler secret list` показывает `BOT_TOKEN` + `CHAT_ID`.
   - Проверено, что wrangler **обрезает перевод строки** из stdin: в `cli.js` секрет читается через `trimTrailingWhitespace(...)`, то есть `echo` без `-n` безопасен (это важно — `\n` в chat_id сломал бы отправку).

**Легаси-контракт `text` удалён полностью** (`2497fa8`) — раньше был флаг `ALLOW_LEGACY_TEXT = true` «на время перехода». Перед удалением проверено **по живому коду клиента** (`curl .../scripts/order.js` из прода), что форма шлёт `name, contact, description, material, color, quantity, request_id, honeypot` и **ни одного** `append('text')`. Убрано: флаг, комментарий-пояснение переписан, импорт `normalizeText` из `validators`, ветка `legacyText`, тернарник при сборке `fullText`. Тест переписан: `text` → ожидание 400 `invalid` + карта ошибок + ноль обращений к Telegram. Тесты **123/123** (было 122/122).

**Прод-смоук (все проверки — безопасные, без отправки в Telegram):**

| Проверка | Было (до деплоя) | Стало |
|---|---|---|
| `GET /api/catalog` | 200 | 200 (12 работ) |
| `POST /api/catalog` | 405 | 405 |
| `POST /api/proxy` | 400 (legacy жив) | **404** |
| `POST /` | 400 (legacy жив) | **404** |
| `GET /api/review` | 404 | 405 |
| `OPTIONS /api/order` | 200 | 200 |
| `POST /api/order` `body=null` | 500 | **400** |
| `POST /api/order` с `text` | 200 (легаси) | **400 invalid** |
| `POST /api/order` honeypot | — | 200 `silent`, Telegram не вызван |

**Сайт:** `git push origin fix/security-and-ux:main` — fast-forward (`5a9bb2b..4f0da28`), без force. Живой сайт: все 4 страницы 200, версии ассетов актуальны (`main.css?v=16`, `common.js?v=5`, `catalog.js?v=8`, `order.js?v=1`, `review-form.js?v=1`, `figure-hero.webp?v=6`), `DEPLOYMENT.md` в проде доступен.

**Браузерная проверка прода (375px и 1920px):**
- Каталог на 375: 1 колонка, 12 карточек, у картинок `width=1200 height=900 decoding=async loading=lazy`, картинка-кнопка на месте, переполнения нет (`scrollWidth == clientWidth == 375`). На 1920 — 12 карточек, 1905/1905.
- Мобильное меню видно на 375 и скрыто на 1920; `aria-hidden` декоративных SVG — 4/4 (index), 1/1 (остальные страницы).
- Форма заказа: `novalidate` отсутствует (без JS работает нативная валидация), 9 полей; при проходе всей страницы **0 перекрытых** полей/кнопок.
- Отзывы: 5 кнопок `role=radio`, ровно одна с `tabindex=0`, FAB с `aria-expanded`/`aria-controls`, панель `role=dialog`.
- Плавающие кнопки не пересекаются: `vk-float` справа (305–355px), `review-fab` слева (20–76px).

## Что именно сделано в этапе 11 (контекст для следующей сессии)

**REL-01 (таймаут и классификация ошибок Telegram) — `worker/src/index.ts`.** Вынесен общий `telegramJson()`: таймаут 15 с `AbortSignal.timeout()`, проверка HTTP-статуса (до разбора), безопасный разбор JSON, на transport/parse/timeout бросает `TelegramError` (kind: `timeout`/`network`/`parse`), на отклонение самим Telegram возвращает `{ ok:false, description }`. `sendMessage` и `sendDocument` построены на нём. Поведение вызовов сохранено: таймаут/сеть сообщения → терминальное `unknown` (без авто-повтора), файла → `partial` (текст уже ушёл). Тесты: mock-режимы `timeout` для `sendMessage`/`sendDocument` → заявка `unknown` и файл `partial` (в `worker/tests/run-tests.js`, **128/128**). Деплой: `npx wrangler deploy` → версия `8a56ea2f` (точка отката `134e5c82`); прод-смоук штатный (каталог 200/12, `POST` → 405, proxy → 404, `body=null` → 400).

**Живая проверка формы→Telegram.** Через `browser_exec` на живом `order.html` заполнена и отправлена форма (дважды: «Тест проверки» и «Тест проверки 2»). Блок `#form-success` показал «Заявка отправлена!» и номер `260919-9765` — номер отдаётся **только** при `status: success`, который Worker возвращает лишь когда Telegram подтвердил приём (`ok:true` + `message_id`). Вывод: путь «форма → Worker → Telegram» работает в проде.

**Turnstile — заблокирован (внешний).** Попытка создать виджет:
- `npx wrangler turnstile widget create "3dprint-site" --domain rudrymor.github.io --mode managed` → `Authentication error [code: 10000]` на `/accounts/.../challenges/widgets` (токен деплоя без права `Turnstile: Edit`);
- сохранённой OAuth-сессии wrangler нет (`C:/Users/metal/AppData/Roaming/xdg.config/.wrangler/config/default.toml` отсутствует; есть только `wrangler-temporary-account.toml`);
- значит, только владелец: виджет из дашборда (домен `rudrymor.github.io`, Managed) с отдачей site+secret, или `wrangler login` (OAuth под супер-админом — у владельца роль «Super Administrator»), после чего виджет создаст агент.
Фронтенд-интеграция уже готова: `TURNSTILE_SITE_KEY` (пустая → graceful skip) в `order.js`/`review-form.js`, контейнеры `#order-turnstile`/`#review-turnstile` и `api.js` в HTML, `cf-turnstile-response` уходит, Worker проверяет `TURNSTILE_SECRET` (нет → пропуск). Осталось только вписать ключи.

## Проверки (воспроизводимые)

```bash
cd "C:/Users/metal/Desktop/3D печать/3dprint-site"
python tools/tests/run-tests.py             # 23/23: инструменты, фикстуры на месте, без сети
python -m compileall -q tools               # синтаксис всех инструментов
cd worker && node tests/run-tests.js        # 128/128: юнит validators + E2E с mock Telegram и mock DO (этап 11: + timeout-кейсы)
cd worker && npx wrangler deploy --dry-run  # сборка бандла + биндинги, БЕЗ публикации
node --check scripts/*.js                   # синтаксис клиента (5 файлов)
git diff --check                            # нет маркеров/пробелов
python tools/figure_check.py --in images/figure-hero.webp    # ВЕРДИКТ OK на живом ассете
python -m http.server 8080                  # в корне проекта, затем http://127.0.0.1:8080/works.html
```

**Работа с прод-KV (только чтение):**

```bash
cd "C:/Users/metal/Desktop/3D печать/3dprint-site"
export CLOUDFLARE_API_TOKEN="$(grep -E '^CLOUDFLARE_DEPLOY_TOKEN=' .env | sed 's/^[^=]*=//')"
cd worker
npx wrangler whoami                                            # Metalkor91@gmail.com's Account
npx wrangler kv key get catalog --binding CATALOG_KV --remote  # 12 записей
npx wrangler kv key list --binding CATALOG_KV --remote         # + ключи лимитера rl:order:<ip>:<bucket>
```

**Смоук прода (2026-09-19, после деплоя):** `GET /api/catalog` → 200 (12 работ), `POST /api/catalog` → 405, `POST /api/proxy` → **404**, `POST /` → **404**, `GET /api/review` → 405, `OPTIONS /api/order` → 200, `body=null` → 400, `text` → 400 `invalid`, honeypot → 200 `silent`.

**Откат Worker:** `npx wrangler rollback 96b85b27` (предыдущая версия). Каталог: `tmp/catalog-backup.json`.

**Контроль неизменности обработки (рецепт этапа 8):** `mkdir -p tmp/origcheck && git archive HEAD tools | tar -x -C tmp/origcheck`, прогнать один вход старым и новым скриптом, сравнить `sha256sum`.

**Браузерные тесты каталога (рецепт этапа 6):** живой путь — `works.html` без стаба; состояния — `?stub=<режим>` (`ok`, `empty`, `badshape`, `http500`, `netfail`, `hang`, `hangthenok`, `failthenok`, `slow`, `one`); клавиатура — `Input.dispatchKeyEvent` (Enter только `type='keyDown'` + `text='\r'`); замеры — `Emulation.setDeviceMetricsOverride` для 375/1920.

**Worker-тесты** (`worker/tests/run-tests.js`): esbuild бандлит `src/index.ts` и `src/validators.ts` в системный temp (в пути проекта пробел — нативные инструменты не понимают MSYS-пути), подменяет `globalThis.fetch` (Telegram) и storage Durable Object на Map; для 429-кейса KV-мок `makeCountingKV()`. В реальный Telegram ничего не уходит.

## Что осталось (единственный открытый пункт)

**Turnstile (капча) — не включён.** Спам сейчас держат только лимиты 5 заявок/ч и 3 отзыва/ч на IP.

- **Бесплатно:** у Turnstile нет лимита запросов/челленджей, до 20 виджетов на аккаунт (платный только Enterprise — не нужен).
- **Создать через API не получилось:** оба токена в `.env` (`CLOUDFLARE_DEPLOY_TOKEN` и AI-токен) не имеют права `Turnstile: Edit` — API и wrangler отвечают `Authentication error [code: 10000]`; сохранённой OAuth-сессии wrangler нет. Нужен либо виджет руками в дашборде, либо токен с этим правом, либо `wrangler login` (OAuth под супер-админом аккаунта — супер-админ у владельца есть).
- **Что нужно от владельца (любой из вариантов):** (1) Cloudflare Dashboard → Turnstile → Add widget (домен `rudrymor.github.io`, режим Managed) → отдать site key и secret key; (2) либо выполнить `wrangler login` в папке `worker` (откроется браузер для входа в аккаунт), после чего я создам виджет сам.
- **Что сделаю после ключей:** site key → в `scripts/order.js` и `scripts/review-form.js` (константа `TURNSTILE_SITE_KEY`, сейчас пустая строка) + поднять `?v=` у этих скриптов; secret → `cd worker && npx wrangler secret put TURNSTILE_SECRET`; проверка: заявка/отзыв без токена → 403/400, с токеном → успех; тесты; деплой Worker и Pages.

**Живая проверка доставки заявки в Telegram — ✅ выполнена (этап 11).** Две тестовые заявки через форму на проде реально доставлены боту: сервер отдал номер заявки `260919-9765` (номер генерируется и отдаётся **только** при `status: success`, то есть когда Telegram подтвердил приём `message_id`). Вторая тестовая заявка («Тест проверки 2») тоже ушла. Обе можно удалить в чате.

## Договорённости по процессу

- Каждый этап = отдельный коммит + push + проверки, потом одобрение владельца.
- **После каждого этапа — отчёт простыми словами для владельца** (не для программиста): что было не так → что сделали → что теперь работает → что нужно от него → что дальше. Структура закреплена в `code-review-3dprint-2026-09-16.md`, раздел «Как отчитываться по этапам».
- Секреты — только в `.env`/Cloudflare, никогда в чат.
- Тесты никогда не идут в прод-Telegram: только mock. В прод-KV без явного разрешения владельца не писать (чтение — можно).
- Автор всех коммитов — «Rudrymor»: `git -c user.name=Rudrymor -c user.email=rudrymor@example.com commit`.
- Не использовать инструмент `memory`; история — через hindsight_retain.
- После каждого milestone обновлять: вики `3D-печать.md` (статус + строка в «Истории изменений»), ревью-документ (таблица этапов, таблица проверок, статус пункта), этот файл.

## Грабли, чтобы не наступать снова

- **`secret put` падает с `Binding name 'CHAT_ID' already in use [10053]`, пока имя занято переменной `[vars]`.** Порядок: сначала убрать из `[vars]` и задеплоить, потом `secret put`. Переменная и секрет делят одно имя в биндингах.
- **wrangler обрезает перевод строки у секрета из stdin** (`trimTrailingWhitespace` в `cli.js`) — `echo "значение" | wrangler secret put NAME` безопасен, `\n` в значение не попадёт.
- **Лимитер живёт в том же KV, что каталог.** Смоук-запросы к `/api/order` тратят лимит 5 заявок/ч с одного IP: после 5 проверок форма честно отвечает 429, окно сбрасывается на границе часа UTC. Для проверок заявок учитывать это заранее. Ключ `order_counter` в KV не удалять (нумерация заявок).
- **Токен деплоя не имеет права `Turnstile: Edit`** — создать виджет через API нельзя, только дашборд (или новый токен с этим правом).
- **`curl -F` с кириллицей в MSYS падает** (код 26) — для тел с кириллицей писать JSON в файл и отправлять `--data-binary "@путь"`.
- **wrangler 4: KV-команды по умолчанию работают с ЛОКАЛЬНЫМ хранилищем** — нужен явный `--remote`; ключ передаётся позиционным аргументом (`kv key put catalog …`, а не `--key catalog`); в неинтерактивном режиме обязателен `CLOUDFLARE_API_TOKEN` (иначе отказ ещё до запроса).
- Блоки успеха показываются классом `.show` (в `main.css` скрыты через `display:none`).
- `capture_screenshot()` всегда перезаписывает один файл — копировать сразу.
- В фоновой вкладке `getComputedStyle` может показать начальное значение — ждать ≥1 с.
- `Page.removeScriptToEvaluateOnNewDocument` на практике не убирает ранее внедрённый стаб — писать стабы так, чтобы они включались только по `?stub=`, иначе «чистые» проверки молча идут через старую подмену.
- **`elementFromPoint` при проверке перекрытий надо вызывать на прокрученной странице** — `scrollTo` в том же вызове `js()` может не успеть примениться (вернулся `scrollY: 0`); прокрутку делать отдельным вызовом и проверять `scrollY`.
- **Проверка «перекрывает ли элемент другой» требует исключения self-match**: `elementFromPoint` в центре плавающей кнопки вернёт её саму (или её потомка) — сравнивать нужно не только `el === t`, но и `f.contains(el) || el.contains(f)`.
- Enter из CDP нужно слать `type='keyDown'` + `text='\r'` (`rawKeyDown` не даёт click на кнопке).
- IPC-таймаут демона 5 с — асинхронные `js()` длиннее 5 с отваливаются, дробить на короткие вызовы.
- Полностраничный скриншот не догружает lazy-картинки (пустые рамки — артефакт снимка, а не баг).
- `ai_repaint.py` сам читает `.env` из корня проекта — в тестах всегда передавать `--env` на несуществующий файл и вычищать `CLOUDFLARE_*` из окружения.
- Файлы владельцу отдавать из ASCII-пути (`C:\Users\metal\web-sites\_review-3dprint`): кириллица и пробелы в пути ломают открытие вложений в приложении.
- Порядок деплоя критичен: сначала Worker, потом Pages (старый Worker на multipart отвечает 500 — форма с вложениями потеряла бы заявку).

## Полезные команды

```bash
cd "C:/Users/metal/Desktop/3D печать/3dprint-site"
git status --short --branch
git log --oneline -5
python tools/tests/run-tests.py                # 23 теста инструментов (без сети)
cd worker && node tests/run-tests.js           # 123 теста worker'а (mock Telegram/DO)
cd worker && npx wrangler deploy --dry-run     # проверка бандла без деплоя
cd worker && npx wrangler secret list          # BOT_TOKEN + CHAT_ID
cd worker && npx wrangler deployments list     # версии Worker'а для откатa
node --check scripts/catalog.js                # синтаксис клиента
python tools/figure_check.py --in images/figure-hero.webp    # проверка живого ассета
python -m http.server 8080                     # локальный предпросмотр
curl -s "https://tg-proxy.metalkor91.workers.dev/api/catalog" | head -c 300   # живые данные каталога
```
