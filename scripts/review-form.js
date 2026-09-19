// scripts/review-form.js — вся клиентская логика страницы отзывов (этап 5).
//
// Контракт с Worker (лимиты — зеркало worker/src/validators.ts):
//   POST {WORKER_URL}/api/review   application/json
//     name, text, rating — структурированные поля; текст для Telegram собирает сервер
//     request_id — обязательный UUID v4; при ретрае переиспользуется тот же
//     honeypot, cf-turnstile-response
//   Ответ: { status: 'success' | 'rejected' | 'unknown' | 'invalid' | 'pending' | 'ratelimited' }
//
// Состояние формы: idle → submitting → success | error.
// «Спасибо» показывается ТОЛЬКО после подтверждения от Worker'а (UX-01);
// повторная отправка запрещена (UX-02); авторетрай — только для 409 pending
// (тот же request_id, отправка не дублируется).

(function () {
  'use strict';

  var WORKER_URL = 'https://tg-proxy.metalkor91.workers.dev';
  var VK_URL = 'https://vk.ru/club240742418';

  // ── Лимиты (зеркало Limits в worker/src/validators.ts) ──
  var LIMITS = {
    nameMin: 2,
    nameMax: 100,
    textMin: 10,
    textMax: 2000,
    ratingMin: 1,
    ratingMax: 5
  };

  // Turnstile site key (public — безопасно лежит в статике). Задано → капча
  // рендерится и требуется; на Worker TURNSTILE_SECRET тоже задан. Этап 12.
  var TURNSTILE_SITE_KEY = '0x4AAAAAAE9CzwO8srPH97bB';

  var PENDING_RETRIES = 2;    // сколько раз ждать «отзыв уже обрабатывается»
  var PENDING_DELAY = 2000;   // мс между попытками
  var SUCCESS_AUTOHIDE = 8000;

  function $(id) { return document.getElementById(id); }
  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function collapseWs(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
  function uuidV4() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  // ══ 1. Оценка звёздами: группа radio с корректным состоянием (A11Y-01) ══
  // aria-checked стоит только на выбранной звезде, остальные — false;
  // в группе один tabindex="0" (roving), стрелки двигают выбор и фокус.
  var starButtons = [];
  var rating = 0;

  function setRating(value, focusStar) {
    rating = Math.max(0, Math.min(LIMITS.ratingMax, value));
    var tabbable = rating || LIMITS.ratingMin;
    starButtons.forEach(function (btn) {
      var v = parseInt(btn.getAttribute('data-value'), 10);
      btn.textContent = v <= rating ? '\u2605' : '\u2606';
      btn.setAttribute('aria-checked', v === rating ? 'true' : 'false');
      btn.classList.toggle('active', v <= rating);
      btn.setAttribute('tabindex', v === tabbable ? '0' : '-1');
    });
    var input = $('stars-input');
    if (input) input.value = String(rating);
    // Выбор оценки снимает ошибку «Поставьте оценку».
    var ratingField = fieldByKey('rating');
    if (ratingField && rating >= LIMITS.ratingMin) clearFieldError(ratingField);
    if (focusStar && starButtons[rating - 1]) starButtons[rating - 1].focus();
  }

  function initStars() {
    var group = $('star-rating');
    if (!group) return;
    starButtons = Array.prototype.slice.call(group.querySelectorAll('.star'));

    starButtons.forEach(function (btn) {
      btn.addEventListener('click', function () {
        setRating(parseInt(btn.getAttribute('data-value'), 10), false);
      });

      btn.addEventListener('keydown', function (e) {
        var v = parseInt(btn.getAttribute('data-value'), 10);
        if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
          e.preventDefault();
          setRating(Math.min(LIMITS.ratingMax, v + 1), true);
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
          e.preventDefault();
          setRating(Math.max(LIMITS.ratingMin, v - 1), true);
        } else if (e.key === 'Home') {
          e.preventDefault();
          setRating(LIMITS.ratingMin, true);
        } else if (e.key === 'End') {
          e.preventDefault();
          setRating(LIMITS.ratingMax, true);
        } else if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          setRating(v, false);
        }
      });
    });

    setRating(0, false);
  }

  // ══ 2. Кнопка «Отзыв» и панель формы (A11Y-04) ══
  // Панель немодальная: фон остаётся доступен. Открытие — только кликом или
  // клавиатурой (CSS :hover больше не открывает), Escape закрывает и
  // возвращает фокус на кнопку.
  var fab = null;
  var fabBtn = null;

  function panelIsOpen() { return !!(fab && fab.classList.contains('panel-open')); }

  function openPanel() {
    if (!fab) return;
    fab.classList.add('panel-open');
    if (fabBtn) fabBtn.setAttribute('aria-expanded', 'true');
    var first = $('review-name');
    if (first && first.focus) first.focus();
  }

  function closePanel(returnFocus) {
    if (!fab) return;
    fab.classList.remove('panel-open');
    if (fabBtn) fabBtn.setAttribute('aria-expanded', 'false');
    if (returnFocus && fabBtn && fabBtn.focus) fabBtn.focus();
  }

  function initFab() {
    fab = $('review-fab');
    fabBtn = $('review-fab-btn');
    if (!fab || !fabBtn) return;

    fabBtn.addEventListener('click', function () {
      if (panelIsOpen()) closePanel(true);
      else openPanel();
    });

    // Клик мимо панели закрывает её (фокус не переводим — пользователь уже кликнул).
    document.addEventListener('click', function (e) {
      if (panelIsOpen() && !fab.contains(e.target)) closePanel(false);
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && panelIsOpen()) closePanel(true);
    });
  }

  // ══ 3. Форма отзыва ══
  var state = {
    submitting: false,
    requestId: null,   // живёт до терминального состояния: ретрай не создаёт дубль
    turnstileToken: '',
    turnstileWidget: null
  };

  var FIELDS = [
    {
      key: 'name', input: 'review-name', error: 'review-name-error',
      validate: function (v) {
        v = collapseWs(v);
        if (v.length < LIMITS.nameMin) {
          return 'Имя — от ' + LIMITS.nameMin + ' до ' + LIMITS.nameMax + ' символов';
        }
        if (v.length > LIMITS.nameMax) {
          return 'Имя слишком длинное — максимум ' + LIMITS.nameMax + ' символов';
        }
        return '';
      }
    },
    {
      key: 'text', input: 'review-text', error: 'review-text-error',
      validate: function (v) {
        v = String(v || '').trim();
        if (v.length < LIMITS.textMin) {
          return 'Расскажите подробнее — минимум ' + LIMITS.textMin + ' символов';
        }
        if (v.length > LIMITS.textMax) {
          return 'Слишком длинный отзыв — максимум ' + LIMITS.textMax + ' символов';
        }
        return '';
      }
    },
    {
      key: 'rating', input: null, inputGroup: 'star-rating', error: 'review-rating-error',
      validate: function () {
        if (rating < LIMITS.ratingMin) return 'Поставьте оценку — от 1 до 5 звёзд';
        return '';
      }
    }
  ];

  function fieldByKey(key) {
    for (var i = 0; i < FIELDS.length; i++) if (FIELDS[i].key === key) return FIELDS[i];
    return null;
  }

  function fieldTarget(field) {
    return field.input ? $(field.input) : $(field.inputGroup);
  }

  /** Куда переводить фокус: для звёзд это активная звезда, а не контейнер. */
  function fieldFocusEl(field) {
    if (field.input) return $(field.input);
    var group = field.inputGroup ? $(field.inputGroup) : null;
    if (!group) return null;
    return group.querySelector('[tabindex="0"]') || group;
  }

  function setFieldError(field, message) {
    var target = fieldTarget(field);
    var box = $(field.error);
    if (target) target.setAttribute('aria-invalid', 'true');
    if (box) {
      box.textContent = message;
      box.classList.remove('is-hidden');
    }
  }

  function clearFieldError(field) {
    var target = fieldTarget(field);
    var box = $(field.error);
    if (target) target.removeAttribute('aria-invalid');
    if (box) {
      box.textContent = '';
      box.classList.add('is-hidden');
    }
  }

  function setStatus(message, kind) {
    var el = $('review-status');
    if (!el) return;
    el.textContent = message || '';
    el.className = 'form-status' + (kind ? ' is-' + kind : '');
  }

  function collectPayload() {
    return {
      name: collapseWs($('review-name') ? $('review-name').value : ''),
      text: String($('review-text') ? $('review-text').value : '').trim(),
      rating: rating
    };
  }

  /** Валидация на клиенте. Возвращает true, если можно отправлять. */
  function validateForm() {
    var payload = collectPayload();
    var firstInvalid = null;

    FIELDS.forEach(function (field) {
      var message = field.validate(payload[field.key]);
      if (message) {
        setFieldError(field, message);
        if (!firstInvalid) firstInvalid = fieldFocusEl(field);
      } else {
        clearFieldError(field);
      }
    });

    if (firstInvalid) {
      setStatus('Проверьте форму: не все поля заполнены верно.', 'error');
      // Клавиатурного пользователя переводим к первой ошибке.
      if (firstInvalid.focus) firstInvalid.focus();
      return false;
    }

    setStatus('', '');
    return true;
  }

  /** Один POST. HTTP-код и status приводим к одному словарю состояний. */
  function postReview(payload) {
    return fetch(WORKER_URL + '/api/review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        var status = data && data.status;
        if (!status) {
          if (res.ok) status = 'success';
          else if (res.status === 400) status = 'invalid';
          else if (res.status === 409) status = 'pending';
          else if (res.status === 429) status = 'ratelimited';
          else if (res.status >= 500) status = 'rejected';
          else status = 'unknown';
        }
        return { status: status, http: res.status, data: data || {} };
      });
    });
  }

  /** Ретрай только для 409 pending: тот же request_id, отправки не дублируются. */
  function submitWithRetry(payload, attempt) {
    return postReview(payload)
      .catch(function () { return { status: 'network', http: 0, data: {} }; })
      .then(function (result) {
        if (result.status === 'pending' && attempt < PENDING_RETRIES) {
          setStatus('Отзыв уже обрабатывается, ждём подтверждения…', 'info');
          return delay(PENDING_DELAY).then(function () {
            return submitWithRetry(payload, attempt + 1);
          });
        }
        return result;
      });
  }

  function setSubmitting(on) {
    state.submitting = on;
    var btn = document.querySelector('#review-form .btn-submit');
    var form = $('review-form');
    if (btn) {
      if (on) {
        btn.dataset.label = btn.textContent;
        btn.textContent = 'Отправляем…';
        btn.disabled = true;
        btn.setAttribute('aria-busy', 'true');
      } else {
        btn.textContent = btn.dataset.label || 'Отправить';
        btn.disabled = false;
        btn.removeAttribute('aria-busy');
      }
    }
    if (form) form.setAttribute('aria-busy', on ? 'true' : 'false');
  }

  function showSuccess() {
    var form = $('review-form');
    var success = $('review-success');
    if (!form || !success) return;

    form.classList.add('is-hidden');
    // Блок успеха в main.css скрыт через display:none и показывается классом .show
    // (та же конвенция, что и на странице заявки).
    success.classList.add('show');
    setStatus('', '');
    // Фокус на сообщение: клавиатурный пользователь его услышит и увидит.
    if (success.focus) success.focus();

    setTimeout(resetAfterSuccess, SUCCESS_AUTOHIDE);
  }

  function resetAfterSuccess() {
    var form = $('review-form');
    var success = $('review-success');
    if (success) success.classList.remove('show');
    if (form) {
      form.classList.remove('is-hidden');
      form.reset();
    }
    FIELDS.forEach(clearFieldError);
    setRating(0, false);
    setStatus('', '');
    closePanel(false);
  }

  function handleResult(result) {
    switch (result.status) {
      case 'success':
        // Терминальное состояние: следующий отзыв получит новый request_id.
        state.requestId = null;
        showSuccess();
        break;

      case 'invalid': {
        var fields = result.data.fields || {};
        var known = false;
        Object.keys(fields).forEach(function (key) {
          var field = fieldByKey(key);
          if (field) {
            setFieldError(field, fields[key]);
            known = true;
          }
        });
        state.requestId = null;
        setStatus(known ? 'Проверьте подсвеченные поля.' : (result.data.error || 'Отзыв отклонён. Проверьте форму.'), 'error');
        var first = FIELDS.filter(function (f) { return fields[f.key]; })[0];
        var target = first ? fieldFocusEl(first) : null;
        if (target && target.focus) target.focus();
        break;
      }

      case 'ratelimited':
        setStatus(
          result.data.error || 'Слишком много отзывов с этого адреса. Попробуйте позже или напишите во ВКонтакте.',
          'error'
        );
        break;

      case 'rejected':
        // Telegram отказал — при повторной попытке нужен НОВЫЙ request_id.
        state.requestId = null;
        setStatus(result.data.message || 'Telegram отклонил отзыв. Попробуйте ещё раз или напишите во ВКонтакте.', 'error');
        break;

      case 'pending':
        // Дубликат всё ещё в обработке — request_id сохраняем.
        setStatus('Отзыв уже отправляется. Подождите немного и не нажимайте «Отправить» ещё раз.', 'info');
        break;

      case 'network':
      case 'unknown':
      default:
        // Результат неизвестен: НЕ повторяем автоматически и сохраняем request_id,
        // чтобы ручная повторная попытка не создала второй отзыв в Telegram.
        setStatus(
          (result.data && result.data.message) ||
            'Ответ от сервера не получен. Отзыв мог уйти — не отправляйте его повторно.',
          'error'
        );
        break;
    }
  }

  function initTurnstile(attempt) {
      var el = $('review-turnstile');
      if (!el) return;
      if (!TURNSTILE_SITE_KEY) return; // не настроено — проверка пропускается
      attempt = attempt || 0;
      // api.js грузится async defer и может быть готов ПОСЛЕ DOMContentLoaded:
      // ждём появления render (до ~6 с), иначе виджет просто не появится.
      if (!(window.turnstile && window.turnstile.render)) {
        if (attempt < 30) setTimeout(function () { initTurnstile(attempt + 1); }, 200);
        return;
      }
      if (state.turnstileWidget !== null) return; // уже отрисован
      state.turnstileWidget = window.turnstile.render(el, {
        sitekey: TURNSTILE_SITE_KEY,
        callback: function (token) { state.turnstileToken = token; },
        'expired-callback': function () { state.turnstileToken = ''; },
        'error-callback': function () { state.turnstileToken = ''; }
      });
    }

  function resetTurnstile() {
    state.turnstileToken = '';
    if (window.turnstile && state.turnstileWidget !== null && window.turnstile.reset) {
      try { window.turnstile.reset(state.turnstileWidget); } catch (e) {}
    }
  }

  function onSubmit(event) {
    event.preventDefault();

    // Двойной submit: отправка уже идёт — выходим (UX-02).
    if (state.submitting) return;

    // Honeypot: бот заполнил скрытое поле — тихий «успех», POST не делаем.
    var honeypot = $('review-website');
    if (honeypot && honeypot.value.trim()) {
      state.requestId = null;
      showSuccess();
      return;
    }

    if (!validateForm()) return;

    if (TURNSTILE_SITE_KEY && !state.turnstileToken) {
      setStatus('Подтвердите, что вы не робот.', 'error');
      return;
    }

    if (!state.requestId) state.requestId = uuidV4();
    var payload = {
      name: collapseWs($('review-name') ? $('review-name').value : ''),
      text: String($('review-text') ? $('review-text').value : '').trim(),
      rating: rating,
      request_id: state.requestId,
      honeypot: honeypot ? honeypot.value : '',
      'cf-turnstile-response': state.turnstileToken
    };

    setSubmitting(true);
    setStatus('Отправляем отзыв…', 'info');

    submitWithRetry(payload, 0).then(
      function (result) {
        handleResult(result);
        setSubmitting(false);
        // Turnstile-токен одноразовый: после любой попытки берём новый.
        resetTurnstile();
      },
      function () {
        // Сюда попадаем только при неожиданной ошибке клиента — введённое не теряем.
        setStatus('Не получилось отправить отзыв. Проверьте связь и попробуйте снова.', 'error');
        setSubmitting(false);
        resetTurnstile();
      }
    );
  }

  function initForm() {
    var form = $('review-form');
    if (!form) return;

    // Живая очистка ошибки поля, как только пользователь начал исправлять.
    FIELDS.forEach(function (field) {
      if (!field.input) return;
      var input = $(field.input);
      if (!input) return;
      input.addEventListener('input', function () {
        if (input.getAttribute('aria-invalid') === 'true' && !field.validate(input.value)) {
          clearFieldError(field);
        }
      });
    });

    // novalidate убран: без JS браузер сам блокирует пустую отправку.
    // При работающем JS перехватываем клик по кнопке и submit, чтобы показать
    // свои сообщения рядом с полями и перевести фокус к первой ошибке.
    var submitBtn = form.querySelector('.btn-submit');
    if (submitBtn) {
      submitBtn.addEventListener('click', function (event) {
        if (state.submitting) {
          event.preventDefault();
          return;
        }
        if (validateForm() === false) event.preventDefault();
      });
    }

    // Гасим нативные подсказки: сообщения рисуем сами (единый вид и a11y).
    form.addEventListener('invalid', function (event) { event.preventDefault(); }, true);

    form.addEventListener('submit', onSubmit);

    initTurnstile();
  }

  document.addEventListener('DOMContentLoaded', function () {
    initStars();
    initFab();
    initForm();
  });
})();
