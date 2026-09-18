// scripts/catalog.js — каталог работ страницы works.html (этап 6).
//
// Контракт с Worker (валидация — зеркало validateCatalogPayload в worker/src/validators.ts):
//   GET {WORKER_URL}/api/catalog
//     200 → { items: [...] }        (в KV пусто → { items: [], updated: null })
//     500 → { error: '...' }        (битые данные в KV)
//
// Состояния каталога: loading → success | empty | error.
//   • empty  — явное сообщение вместо вечной «Каталог загружается…» (UX-03);
//   • error  — сообщение + кнопка retry, запрос ограничен таймаутом (UX-03, PERF-02);
//   • у картинок есть width/height/decoding (PERF-01);
//   • изображение открывается и с клавиатуры (A11Y-02).
//
// Данные из KV рендерятся только через DOM API (textContent/createElement),
// битые записи отбрасываются на клиенте — defense-in-depth к серверной проверке.

(function () {
  'use strict';

  var CATALOG_API = 'https://tg-proxy.metalkor91.workers.dev/api/catalog';

  // ── Лимиты (зеркало Limits в worker/src/validators.ts) ──
  var REQUEST_TIMEOUT = 10000; // мс: дольше — error с retry, а не вечный loading (PERF-02)
  var MAX_ITEMS = 100;
  var NAME_MAX = 200;
  var DESC_MAX = 1000;
  var FIELD_MAX = 100;
  var IMG_W = 1200;      // intrinsic-размер по умолчанию — 4:3, как aspect-ratio
  var IMG_H = 900;       // контейнера .catalog-card-img (PERF-01)
  var IMG_DIM_MAX = 10000;

  // ── КАТЕГОРИИ ──
  var CATEGORY_META = {
    techno: {
      title: 'Инженерные и функциональные детали',
      sub: 'Проектирование 3D модели по чертежу, эскизу или оригиналу для последующей 3D печати',
      label: 'работ в этой подборке'
    },
    decor: {
      title: 'Авторские 3D фигурки',
      sub: 'Лимитированная коллекция',
      label: 'работ в этой подборке'
    }
  };

  function $(id) { return document.getElementById(id); }

  // ── ВАЛИДАЦИЯ URL ИЗОБРАЖЕНИЯ ──
  // Дублирует серверную проверку для defense-in-depth
  function isSafeImageUrl(url) {
    if (!url || typeof url !== 'string') return false;
    if (/^(https?:|javascript:|data:|\/\/)/i.test(url)) return false;
    if (!url.startsWith('images/')) return false;
    if (url.includes('..')) return false;
    if (url.length > 200) return false;
    if (!/^images\/[a-zA-Z0-9_\-./]+\.(jpg|jpeg|png|gif|webp|svg)$/i.test(url)) return false;
    return true;
  }

  // ── ВАЛИДАЦИЯ ЭЛЕМЕНТА КАТАЛОГА ──
  // Зеркало validateCatalogItem на Worker'е: одна битая запись не ломает каталог.
  function validateCatalogItem(item) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    // name: строка 1..200
    if (typeof item.name !== 'string') return false;
    if (item.name.trim().length < 1 || item.name.trim().length > NAME_MAX) return false;
    // description: опциональна, строка до 1000
    if (item.description !== undefined && item.description !== null && typeof item.description !== 'string') return false;
    if (typeof item.description === 'string' && item.description.length > DESC_MAX) return false;
    // image: опциональна, но если есть — только безопасный путь images/*
    if (item.image !== undefined && item.image !== null && typeof item.image !== 'string') return false;
    if (typeof item.image === 'string' && item.image !== '' && !isSafeImageUrl(item.image)) return false;
    // category: опциональна, 'techno' | 'decor'
    if (item.category !== undefined && item.category !== null && item.category !== '' && !CATEGORY_META[item.category]) return false;
    // id: опциональный целый неотрицательный
    if (item.id !== undefined && item.id !== null && (!Number.isInteger(item.id) || item.id < 0)) return false;
    // material / price_s / price_m / price_l: опциональные строки до 100
    var fields = ['material', 'price_s', 'price_m', 'price_l'];
    for (var i = 0; i < fields.length; i++) {
      var v = item[fields[i]];
      if (v === undefined || v === null) continue;
      if (typeof v !== 'string' || v.length > FIELD_MAX) return false;
    }
    return true;
  }

  /** Intrinsic-размеры картинки: из данных записи, иначе стабильные 4:3 (PERF-01). */
  function imageSize(item) {
    var w = item ? item.width : null;
    var h = item ? item.height : null;
    if (Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0 && w <= IMG_DIM_MAX && h <= IMG_DIM_MAX) {
      return { w: w, h: h };
    }
    return { w: IMG_W, h: IMG_H };
  }

  // ── ПРОВЕРКА ОТВЕТА WORKER'А ──
  /**
   * Приводит ответ API к контролируемому результату.
   * @returns {{ok: true, items: Array}} | {{ok: false, reason: string}}
   */
  function normalizePayload(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { ok: false, reason: 'ответ не объект' };
    }
    if (!Array.isArray(data.items)) {
      return { ok: false, reason: 'items не массив' };
    }
    if (data.items.length > MAX_ITEMS) {
      return { ok: false, reason: 'записей больше лимита (' + MAX_ITEMS + ')' };
    }
    var items = [];
    var dropped = 0;
    for (var i = 0; i < data.items.length; i++) {
      if (validateCatalogItem(data.items[i])) items.push(data.items[i]);
      else dropped++;
    }
    if (dropped) console.warn('Catalog: отброшено битых записей —', dropped);
    return { ok: true, items: items };
  }

  // ── СОСТОЯНИЯ (loading / empty / error) ──
  /**
   * Рисует состояние каталога в #catalog-root.
   * kind: 'loading' | 'empty' | 'error'; opts.link — {href, text} для empty.
   * Текст всегда попадает в DOM как textContent, не через innerHTML.
   */
  function renderState(kind, text, opts) {
    var root = $('catalog-root');
    if (!root) return;
    opts = opts || {};

    root.className = 'catalog-state' + (kind === 'error' ? ' is-error' : '');
    // role=status (loading/empty) и role=alert (error) — скринридер услышит смену состояния.
    root.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    root.setAttribute('aria-busy', kind === 'loading' ? 'true' : 'false');
    while (root.firstChild) root.removeChild(root.firstChild);

    var p = document.createElement('p');
    p.className = 'catalog-state-text';
    p.textContent = text;
    root.appendChild(p);

    if (opts.link) {
      var a = document.createElement('a');
      a.className = 'btn-primary';
      a.href = opts.link.href;
      a.textContent = opts.link.text;
      root.appendChild(a);
    }

    if (kind === 'error') {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn-primary';
      btn.id = 'catalog-retry';
      btn.textContent = 'Попробовать снова';
      btn.addEventListener('click', function () {
        // Клик по retry — единственный вход в повторную загрузку;
        // параллельные запросы отсекает флаг в loadCatalog().
        loadCatalog();
      });
      root.appendChild(btn);
    }
  }

  // ── ОТРИСОВКА КАТАЛОГА ──
  function renderCatalog(items) {
    var root = $('catalog-root');
    if (!root) return;

    root.className = 'catalog-grid';
    root.removeAttribute('role');
    root.removeAttribute('aria-busy');
    while (root.firstChild) root.removeChild(root.firstChild);

    items.forEach(function (item) {
      var name = item.name.trim();

      var card = document.createElement('div');
      card.className = 'catalog-card';

      var imgContainer = document.createElement('div');
      imgContainer.className = 'catalog-card-img';

      var img = item.image && isSafeImageUrl(item.image) ? item.image : '';

      if (img) {
        // Кнопка внутри рамки: изображение открывается и мышью, и с клавиатуры (A11Y-02).
        var trigger = document.createElement('button');
        trigger.type = 'button';
        trigger.className = 'catalog-card-img-btn';
        trigger.setAttribute('aria-label', 'Открыть фото: ' + name);
        trigger.setAttribute('aria-haspopup', 'dialog');

        var imgEl = document.createElement('img');
        imgEl.src = img;
        // alt пустой: доступное имя уже несёт кнопка, дублировать его не нужно.
        imgEl.alt = '';
        var size = imageSize(item);
        imgEl.setAttribute('width', String(size.w));
        imgEl.setAttribute('height', String(size.h));
        imgEl.setAttribute('loading', 'lazy');
        imgEl.setAttribute('decoding', 'async');

        trigger.appendChild(imgEl);
        imgContainer.appendChild(trigger);
      } else {
        if (item.image) console.warn('Catalog: URL изображения отклонён:', item.image);
        var placeholder = document.createElement('span');
        placeholder.className = 'catalog-card-img-placeholder';
        placeholder.textContent = '🖨️';
        imgContainer.appendChild(placeholder);
      }

      var body = document.createElement('div');
      body.className = 'catalog-card-body';

      var title = document.createElement('h3');
      title.className = 'catalog-card-title';
      title.textContent = name;

      var descEl = document.createElement('p');
      descEl.className = 'catalog-card-desc';
      descEl.textContent = item.description || '';

      body.appendChild(title);
      body.appendChild(descEl);
      card.appendChild(imgContainer);
      card.appendChild(body);
      root.appendChild(card);
    });

    // Лайтбокс создаётся один раз, список триггеров обновляем на каждый рендер.
    ensureLightbox().bind(Array.prototype.slice.call(root.querySelectorAll('.catalog-card-img-btn')));
  }

  // ── ЛАЙТБОКС ──
  var lb = null;
  var lbInertEls = [];

  /**
   * Создаёт лайтбокс при первом вызове и возвращает его API: {bind, open, close, isOpen}.
   * Один экземпляр на страницу — повторные рендеры каталога (retry) не плодят оверлеи.
   */
  function ensureLightbox() {
    if (lb) return lb;

    var box = document.createElement('div');
    box.className = 'lightbox';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', 'Просмотр изображения');
    box.innerHTML =
      '<button class="lb-btn lb-close" aria-label="Закрыть">×</button>' +
      '<button class="lb-btn lb-prev" aria-label="Предыдущая">‹</button>' +
      '<img class="lb-img" src="" alt="">' +
      '<button class="lb-btn lb-next" aria-label="Следующая">›</button>' +
      '<div class="lb-caption"></div>';
    document.body.appendChild(box);

    var imgEl = box.querySelector('.lb-img');
    var capEl = box.querySelector('.lb-caption');
    var prevBtn = box.querySelector('.lb-prev');
    var nextBtn = box.querySelector('.lb-next');
    var triggers = [];
    var idx = 0;
    var lastFocused = null;

    function isOpen() { return box.classList.contains('open'); }

    function show(i) {
      if (!triggers.length) return;
      idx = (i + triggers.length) % triggers.length;
      var source = triggers[idx];
      var card = source.closest('.catalog-card');
      var title = card ? card.querySelector('.catalog-card-title') : null;
      var label = title ? title.textContent.trim() : '';
      var sourceImg = source.querySelector('img');

      imgEl.src = sourceImg ? sourceImg.src : '';
      imgEl.alt = label;
      // Подпись — DOM API: имя приходит из KV, innerHTML для него не используем.
      while (capEl.firstChild) capEl.removeChild(capEl.firstChild);
      if (label) {
        var strong = document.createElement('strong');
        strong.textContent = label;
        capEl.appendChild(strong);
      }
      // Одна картинка в каталоге — навигация не нужна, убираем кнопки из tab-порядка.
      var single = triggers.length < 2;
      prevBtn.hidden = single;
      nextBtn.hidden = single;
    }

    // Фон уходит в inert: пока открыт диалог, до ссылок и меню не добраться ни Tab'ом,
    // ни кликом. Возвращаем только те атрибуты, которые поставили сами.
    function setBackgroundInert(on) {
      if (on) {
        var children = document.body.children;
        for (var i = 0; i < children.length; i++) {
          var el = children[i];
          if (el === box || el.tagName === 'SCRIPT' || el.hasAttribute('inert')) continue;
          el.setAttribute('inert', '');
          lbInertEls.push(el);
        }
      } else {
        lbInertEls.forEach(function (el) { el.removeAttribute('inert'); });
        lbInertEls = [];
      }
    }

    function open(i, trigger) {
      lastFocused = trigger || document.activeElement;
      show(i);
      box.classList.add('open');
      document.body.classList.add('lb-open');
      box.querySelector('.lb-close').focus();
    }

    function close() {
      box.classList.remove('open');
      document.body.classList.remove('lb-open');
      setBackgroundInert(false);
      if (lastFocused && lastFocused.focus) lastFocused.focus();
      lastFocused = null;
    }

    // Ловушка фокуса: внутри диалога три кнопки — по кругу (страховка к inert).
    box.addEventListener('keydown', function (e) {
      if (e.key !== 'Tab') return;
      var focusable = Array.prototype.filter.call(box.querySelectorAll('button'), function (b) { return !b.hidden; });
      if (!focusable.length) return;
      var first = focusable[0];
      var last = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) { e.preventDefault(); last.focus(); }
      } else if (document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    });

    box.querySelector('.lb-close').addEventListener('click', close);
    nextBtn.addEventListener('click', function (e) { e.stopPropagation(); show(idx + 1); });
    prevBtn.addEventListener('click', function (e) { e.stopPropagation(); show(idx - 1); });
    box.addEventListener('click', function (e) { if (e.target === box) close(); });

    document.addEventListener('keydown', function (e) {
      if (!isOpen()) return;
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowRight') show(idx + 1);
      else if (e.key === 'ArrowLeft') show(idx - 1);
    });

    lb = {
      bind: function (els) {
        triggers = els;
        els.forEach(function (el, i) {
          el.addEventListener('click', function () {
            setBackgroundInert(true);
            open(i, el);
          });
        });
      },
      open: open,
      close: close,
      isOpen: isOpen
    };
    return lb;
  }

  // ── ВЫБОРКА ПО КАТЕГОРИИ ИЗ URL ──
  function getCatalogView(items) {
    var cat = new URLSearchParams(location.search).get('cat');
    if (cat && CATEGORY_META[cat]) {
      return {
        cat: cat,
        items: items.filter(function (i) { return i.category === cat; }),
        meta: CATEGORY_META[cat]
      };
    }
    return { cat: '', items: items, meta: null };
  }

  // ── СЧЁТЧИК, ЗАГОЛОВОК, TITLE ──
  /** count === null → счётчика нет (идёт загрузка или каталог недоступен). */
  function updatePage(view, count) {
    var numEl = $('work-count');
    if (numEl && count !== null) numEl.textContent = String(count);

    var section = document.querySelector('.counter-section');
    if (section) section.classList.toggle('is-hidden', count === null);

    var labelEl = $('work-count-label');
    if (labelEl && view.meta) labelEl.textContent = view.meta.label;

    if (view.meta) {
      var titleEl = $('works-title');
      var subEl = $('works-sub');
      if (titleEl) titleEl.textContent = view.meta.title;
      if (subEl) subEl.textContent = view.meta.sub;
      document.title = view.meta.title + ' — 3DArtStudio';
    }
  }

  // ── ЗАГРУЗКА ──
  var state = { loading: false, attempt: 0 };
  var requestSeq = 0;

  function showItems(items) {
    var view = getCatalogView(items);
    if (view.items.length) {
      renderCatalog(view.items);
      updatePage(view, view.items.length);
      return;
    }
    updatePage(view, 0);
    if (view.cat) {
      renderState('empty', 'В этой подборке пока нет работ.', {
        link: { href: 'works.html', text: 'Показать все работы' }
      });
    } else {
      renderState('empty', 'Пока нет опубликованных работ.');
    }
  }

  function showError(result) {
    updatePage(getCatalogView([]), null);
    console.error('Catalog API error:', result && result.reason, result && result.detail);
    renderState('error', 'Не удалось загрузить каталог. Проверьте подключение и попробуйте ещё раз.');
  }

  /** Одна загрузка каталога: таймаут, отсечение параллельных запросов, состояние UI. */
  function loadCatalog() {
    var root = $('catalog-root');
    if (!root || state.loading) return;

    state.loading = true;
    state.attempt++;
    var myAttempt = ++requestSeq;

    updatePage(getCatalogView([]), null);
    renderState('loading', 'Загружаем работы…');

    var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timedOut = false;
    var settled = false;
    var timer = null;

    function finish(result) {
      if (settled) return;               // таймер и reject от abort() могут прийти оба
      settled = true;
      clearTimeout(timer);
      if (myAttempt !== requestSeq) return; // ответ устаревшей попытки — игнорируем
      state.loading = false;
      if (result.ok) showItems(result.items);
      else showError(result);
    }

    // Таймаут завершает загрузку сам, не полагаясь на то, что abort() отклонит промис:
    // иначе «зависший» запрос оставил бы страницу в вечном loading (PERF-02).
    timer = setTimeout(function () {
      timedOut = true;
      if (controller) controller.abort();  // освобождаем соединение
      finish({
        ok: false,
        reason: 'timeout ' + REQUEST_TIMEOUT + ' мс',
        detail: 'каталог не ответил за ' + (REQUEST_TIMEOUT / 1000) + ' с'
      });
    }, REQUEST_TIMEOUT);

    var options = { headers: { Accept: 'application/json' } };
    if (controller) options.signal = controller.signal;

    fetch(CATALOG_API, options)
      .then(function (res) {
        return res.json().catch(function () { return null; }).then(function (data) {
          if (!res.ok) {
            return {
              ok: false,
              reason: 'HTTP ' + res.status,
              detail: data && (data.error || data.message) ? (data.error || data.message) : null
            };
          }
          var normalized = normalizePayload(data);
          if (!normalized.ok) normalized.detail = 'неожиданный формат ответа';
          return normalized;
        });
      })
      .then(
        function (result) { finish(result); },
        function (err) {
          finish({
            ok: false,
            reason: timedOut ? 'timeout ' + REQUEST_TIMEOUT + ' мс' : (err && err.name === 'AbortError' ? 'aborted' : 'network'),
            detail: err && err.message ? err.message : null
          });
        }
      );
  }

  // ── ЗАПУСК ──
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadCatalog);
  } else {
    loadCatalog();
  }
})();
