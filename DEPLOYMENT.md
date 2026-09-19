# Деплой и откат (3DArtStudio)

Технический гайд для того, кто выкатывает изменения. Владельцу читать не обязательно — для него всё важное в `README.md`.

Компоненты и адреса:

| Что | Где живёт | Адрес / расположение |
|---|---|---|
| Сайт (статика) | GitHub Pages, ветка `main`, репозиторий `Rudrymor/3dprint-site` | https://rudrymor.github.io/3dprint-site/ |
| Worker `tg-proxy` | Cloudflare Workers (деплой вручную, wrangler) | https://tg-proxy.metalkor91.workers.dev |
| Каталог | Cloudflare KV, namespace `CATALOG`, ключ `catalog` | `fe7b04ba504643ce9f085d1213bd5a09` |
| Идемпотентность заявок | Durable Object `IdempotencyObject` (SQLite) | биндинг `IDEMPOTENCY` |
| Заявки и отзывы | Telegram-бот владельца | `BOT_TOKEN` + `CHAT_ID` |

---

## 0. Подготовка окружения

```bash
cd "C:/Users/metal/Desktop/3D печать/3dprint-site"

# токен деплоя (Workers Scripts: Edit + Workers KV: Edit) — в отдельную переменную,
# под именем, которое понимает wrangler. AI-токен для этого НЕ подходит.
export CLOUDFLARE_API_TOKEN="$(grep -E '^CLOUDFLARE_DEPLOY_TOKEN=' .env | sed 's/^[^=]*=//')"

cd worker && npx wrangler whoami      # должно показать аккаунт Metalkor91@gmail.com's Account
```

Без токена wrangler в неинтерактивном режиме падает с «necessary to set a CLOUDFLARE_API_TOKEN environment variable». Подробности по переменным — `.env.example`.

---

## 1. Проверки ДО деплоя (ничего не публикуют)

```bash
cd "C:/Users/metal/Desktop/3D печать/3dprint-site"

python tools/tests/run-tests.py             # 23/23 — инструменты, без сети
python -m compileall -q tools               # синтаксис инструментов
node --check scripts/*.js                   # синтаксис клиентских скриптов
cd worker && node tests/run-tests.js        # 123/123 — валидаторы + E2E с mock Telegram/DO
cd worker && npx wrangler deploy --dry-run  # сборка бандла + биндинги, БЕЗ публикации
git diff --check                            # нет случайных пробелов и конфликтных маркеров
```

Тесты никогда не ходят в прод-Telegram: подменяется `fetch` (mock Telegram) и storage Durable Object (Map). Реальные заявки и отзывы при проверках не отправляются.

---

## 2. Секреты Worker'а (один раз)

```bash
cd worker
npx wrangler secret put BOT_TOKEN
npx wrangler secret put CHAT_ID
npx wrangler secret put TURNSTILE_SECRET     # пока не задан — Turnstile пропускается
npx wrangler secret list                     # проверить, что все три на месте
```

Отдельно от секретов: публичный **site key** Turnstile прописывается в `scripts/order.js` и `scripts/review-form.js` (там есть константа `TURNSTILE_SITE_KEY`). Создать виджет и получить ключи можно и из CLI: `npx wrangler turnstile`.

`CHAT_ID` вынесен из `wrangler.toml` в секрет (этап 10, коммит `8a337a4`) — в репозитории значения нет. `BOT_TOKEN` и `CHAT_ID` уже стоят в проде; `TURNSTILE_SECRET` пока не задан.

**Turnstile (бесплатно, лимитов запросов нет):** виджет создаётся в Cloudflare Dashboard → Turnstile → Add widget (домен `rudrymor.github.io`, режим Managed) либо через API:

```bash
A=$(grep -E '^CLOUDFLARE_ACCOUNT_ID=' ../.env | sed 's/^[^=]*=//')
T=$(grep -E '^CLOUDFLARE_DEPLOY_TOKEN=' ../.env | sed 's/^[^=]*=//')
curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/$A/challenges/widgets" \
  -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
  -d '{"name":"3dprint-site","domains":["rudrymor.github.io"],"mode":"managed"}'
```

⚠️ Токену нужны права **Turnstile: Edit** — с токеном только на Workers Scripts/KV API отвечает `Authentication error`. Проще создать виджет руками в дашборде: он вернёт site key и secret key сразу.

---

## 3. Порядок деплоя: сначала Worker, потом сайт

Порядок критичен. Старый Worker на `multipart/form-data` отвечает 500, поэтому форма сайта с вложениями, выкаченная раньше серверной части, теряла бы заявку целиком.

### 3.1 Worker

```bash
cd worker
npx wrangler deploy
```

Что должно уехать в прод: роутер только с тремя адресами, валидаторы, Durable Object идемпотентности, защита от спама (лимиты, origin, Turnstile), сборка текста заявки на сервере.

### 3.2 Сайт (GitHub Pages)

```bash
git push origin main          # Pages обновляется автоматически
git log origin/main -1        # убедиться, что улетел нужный коммит
```

Помнить про кэш: после правки CSS/JS/картинок версия в пути (`styles/main.css?v=16`) поднимается вручную, иначе Pages до 10 минут отдаёт старое.

---

## 4. Smoke-проверки после деплоя

### 4.1 Worker (curl)

```bash
W=https://tg-proxy.metalkor91.workers.dev
curl -s -o /dev/null -w '%{http_code}\n' "$W/api/catalog"                  # 200
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$W/api/catalog"         # 405 (запись закрыта)
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$W/api/proxy"           # 404 (legacy удалён)
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$W/"                    # 404 (legacy удалён)
curl -s -o /dev/null -w '%{http_code}\n' -X GET  "$W/api/review"          # 405
curl -s -o /dev/null -w '%{http_code}\n' -X OPTIONS "$W/api/order"        # 200 (CORS preflight)
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$W/api/order" \
  -H 'Content-Type: application/json' -d 'null'                           # 400 (тело — не объект)
curl -s "$W/api/catalog" | head -c 200                                    # каталог из KV
```

**Состояние прода на 2026-09-19 (этап 10 выполнен: Worker `134e5c82`, Pages `main` = `6140221`, деплой-коммит `4f0da28`):**

| Проверка | Было до деплоя | Сейчас в проде |
|---|---|---|
| `GET /api/catalog` | 200 | 200 |
| `POST /api/catalog` | 405 | 405 |
| `POST /api/proxy` | **400 — legacy жив** | **404 — удалён** |
| `POST /` | **400 — legacy жив** | **404 — удалён** |
| `GET /api/review` | 404 | 405 |
| `OPTIONS /api/order` | 200 | 200 |
| `POST /api/order` с `body=null` | 500 | 400 |
| `POST /api/order` с полем `text` | 200 (легаси-контракт) | **400 invalid** — контракт удалён |

### 4.2 Сайт (браузер)

1. Локальный предпросмотр: `python -m http.server 8080` в корне проекта → http://127.0.0.1:8080/
2. Проверить 375px и 1920px на всех четырёх страницах: нет горизонтального скролла, меню и лайтбокс работают с клавиатуры.
3. Форма заказа: пустая форма не создаёт запрос; валидная заявка приходит в Telegram; вложения уходят документами.
4. Форма отзыва: «спасибо» появляется только после ответа сервера.
5. Каталог: `works.html` без параметров и `?cat=techno` / `?cat=decor` — число карточек совпадает с KV.
6. Консоль браузера — без новых ошибок.

### 4.3 Логи

```bash
cd worker && npx wrangler tail tg-proxy     # живой поток structured-логов (JSON)
```

Логи не содержат токенов: пишутся request id, номер заявки и тип ошибки; IP маскируется (`1.2.3.x`).

---

## 5. Откат

### Worker

```bash
cd worker
npx wrangler deployments list                    # версии и id
npx wrangler rollback <version-id>               # вернуть прежнюю версию
```

Перед деплоем имеет смысл сохранить текущий version id — `npx wrangler deployments list` до выкатки.

### Каталог (KV)

```bash
cd worker
npx wrangler kv key get catalog --binding CATALOG_KV --remote > ../tmp/catalog-backup.json   # точка отката ДО правки
npx wrangler kv key put catalog --binding CATALOG_KV --remote "$(cat ../tmp/catalog-backup.json)"   # откат
```

### Сайт (Pages)

```bash
git revert <commit> && git push origin main      # либо
git checkout main && git reset --hard <прежний-коммит> && git push --force-with-lease origin main
```

KV-каталог и Worker живут отдельно от сайта: откат Pages не влияет на приём заявок.

---

## 6. После публикации Pages (выполнено на этапе 10)

1. ✅ Легаси-контракт `text` **удалён полностью** (коммит `2497fa8`): флаг `ALLOW_LEGACY_TEXT`, импорт `normalizeText` и сама ветка убраны из `worker/src/index.ts`. Заявка принимается только структурированными полями.
2. ✅ `cd worker && node tests/run-tests.js` — 123/123 (тест переписан: `text` теперь ожидает 400 `invalid` и ноль обращений к Telegram).
3. ✅ `npx wrangler deploy` — Worker `134e5c82`; прод-проверка: `POST /api/order` с одним `text` → 400 с картой ошибок по полям.
4. ⏳ Turnstile: виджет и ключи (владелец) — единственный незакрытый пункт защиты.
5. ⏳ Обновить вики `C:\Users\metal\wiki\3D-печать.md` и `SESSION-RESUME.md`.

---

## 6.1 Осталось после деплоя

| Что | Кто | Почему важно |
|---|---|---|
| Виджет Turnstile (site + secret key) | владелец | Сейчас капчи нет: спам держат только лимиты 5/ч (заявки) и 3/ч (отзывы) на IP |
| Живая проверка заявки в Telegram | владелец | Проверить доставку после переноса `CHAT_ID` в секрет (тестовая заявка в прод-чате намеренно не отправлялась) |

---

## 7. Чего не делать

- Не деплоить сайт раньше Worker'а (форма с вложениями потеряет заявку).
- Не использовать прод-Telegram для тестов: только mock (`worker/tests/run-tests.js`) или отдельный тестовый чат.
- Не записывать каталог без предварительной точки отката.
- Не запускать `wrangler kv` без `--remote` — команда молча пишет в локальную копию.
- Не коммитить `.env`, секреты и `worker/.wrangler/`.
