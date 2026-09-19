// scripts/order.js — вся клиентская логика страницы заявки (этап 4).
//
// Контракт с Worker (лимиты — зеркало worker/src/validators.ts):
//   POST {WORKER_URL}/api/order   multipart/form-data
//     name, contact, description, material, color, quantity — структурированные поля,
//       текст заявки для Telegram собирает СЕРВЕР (клиент не присылает готовую строку)
//     request_id — обязательный UUID v4; при ретрае переиспользуется тот же
//     honeypot, cf-turnstile-response, files (0..5)
//   Ответ: { status: 'success' | 'partial' | 'rejected' | 'unknown' | 'invalid' | 'pending' }
//
// Состояния UI: idle → submitting → success | partial | error.
// Повторная отправка запрещена (isSubmitting), автоматический ретрай есть только
// для 409 pending (тот же request_id — идемпотентно) и никогда для unknown.

(function () {
  'use strict';

  var WORKER_URL = 'https://tg-proxy.metalkor91.workers.dev';
  var VK_URL = 'https://vk.ru/club240742418';

  // ── Лимиты (зеркало Limits в worker/src/validators.ts) ──
  var LIMITS = {
    maxFiles: 5,
    maxFileSize: 15 * 1024 * 1024,
    maxTotalSize: 40 * 1024 * 1024,
    nameMin: 2,
    nameMax: 100,
    contactMin: 3,
    contactMax: 100,
    descMin: 10,
    descMax: 2000,
    colorMax: 100,
    qtyMin: 1,
    qtyMax: 999
  };

  // Должен совпадать с accept у #attach-input и ALLOWED_EXTENSIONS на сервере.
  var ALLOWED_EXT = [
    'stl', 'obj', '3mf', 'step', 'stp', 'igs', 'iges', 'dwg', 'f3d',
    'zip', 'rar', 'pdf', 'jpg', 'jpeg', 'png', 'webp', 'heic', 'gif'
  ];

  // Turnstile site key (public — безопасно лежит в статике). Задано → капча
  // рендерится и требуется; на Worker TURNSTILE_SECRET тоже задан. Этап 12.
  var TURNSTILE_SITE_KEY = '0x4AAAAAAE9CzwO8srPH97bB';

  var PENDING_RETRIES = 2;   // сколько раз ждать «заявка уже обрабатывается»
  var PENDING_DELAY = 2000;  // мс между попытками
  var SUCCESS_AUTOHIDE = 8000;

  function $(id) { return document.getElementById(id); }
  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function collapseWs(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
  function extOf(name) {
    var i = String(name || '').lastIndexOf('.');
    return i === -1 ? '' : String(name).slice(i + 1).toLowerCase();
  }
  function fmtSize(b) {
    if (b < 1024) return b + ' Б';
    if (b < 1024 * 1024) return Math.round(b / 1024) + ' КБ';
    return (b / 1024 / 1024).toFixed(1) + ' МБ';
  }
  function uuidV4() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  // ══ 1. Тултипы материалов (мобильные) ══
  function initMaterialTips() {
    if (window.innerWidth > 768) return;
    var tips = document.querySelectorAll('.mat-tip');
    tips.forEach(function (tip) {
      var icon = tip.querySelector('.mat-tip-icon');
      if (!icon) return;
      icon.addEventListener('click', function (e) {
        e.stopPropagation();
        var isActive = tip.classList.contains('active');
        tips.forEach(function (t) { t.classList.remove('active'); });
        if (!isActive) tip.classList.add('active');
      });
    });
    document.addEventListener('click', function () {
      tips.forEach(function (t) { t.classList.remove('active'); });
    });
  }

  // ══ 2. Вложения ══
  var attachFiles = [];
  var attachNote = null;

  function attachTotal() {
    return attachFiles.reduce(function (s, f) { return s + f.size; }, 0);
  }

  function setAttachNote(text, isError) {
    if (!attachNote) return;
    attachNote.textContent = text;
    attachNote.classList.toggle('is-error', !!isError);
  }

  function renderAttachments() {
    var list = $('attach-list');
    if (!list) return;
    list.innerHTML = '';
    attachFiles.forEach(function (f, i) {
      var chip = document.createElement('span');
      chip.className = 'attach-chip';

      var name = document.createElement('span');
      name.className = 'attach-chip-name';
      name.textContent = f.name;

      var size = document.createElement('span');
      size.className = 'attach-chip-size';
      size.textContent = fmtSize(f.size);

      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'attach-chip-del';
      del.setAttribute('aria-label', 'Убрать файл ' + f.name);
      del.textContent = '\u00d7';
      del.addEventListener('click', function () {
        attachFiles.splice(i, 1);
        renderAttachments();
      });

      chip.appendChild(name);
      chip.appendChild(size);
      chip.appendChild(del);
      list.appendChild(chip);
    });

    list.classList.toggle('has-files', attachFiles.length > 0);
    setAttachNote(
      attachFiles.length
        ? 'Приложено ' + attachFiles.length + ' из ' + LIMITS.maxFiles + ' файлов (' + fmtSize(attachTotal()) + ')'
        : 'Можно приложить фото, чертёж или 3D-модель — до ' + LIMITS.maxFiles + ' файлов, 15 МБ каждый',
      false
    );
  }

  function clearAttachments() {
    attachFiles = [];
    var input = $('attach-input');
    if (input) input.value = '';
    renderAttachments();
  }

  function initAttachments() {
    var input = $('attach-input');
    var btn = $('attach-btn');
    var list = $('attach-list');
    attachNote = $('attach-note');
    if (!input || !btn || !list) return;

    btn.addEventListener('click', function () { input.click(); });

    input.addEventListener('change', function () {
      var rejected = [];
      Array.prototype.forEach.call(input.files, function (f) {
        if (attachFiles.length >= LIMITS.maxFiles) {
          rejected.push('«' + f.name + '» — уже ' + LIMITS.maxFiles + ' файлов');
          return;
        }
        if (f.size > LIMITS.maxFileSize) {
          rejected.push('«' + f.name + '» больше 15 МБ');
          return;
        }
        if (attachTotal() + f.size > LIMITS.maxTotalSize) {
          rejected.push('общий размер превысит 40 МБ');
          return;
        }
        if (ALLOWED_EXT.indexOf(extOf(f.name)) === -1) {
          rejected.push('формат «' + f.name + '» не поддерживается');
          return;
        }
        var dup = attachFiles.some(function (x) { return x.name === f.name && x.size === f.size; });
        if (!dup) attachFiles.push(f);
      });
      input.value = '';
      renderAttachments();
      if (rejected.length) {
        setAttachNote(
          'Не добавлено: ' + rejected.join('; ') + '. Можно приложить ссылку в описании проекта.',
          true
        );
      }
    });

    // Обратная совместимость с прежним inline-кодом.
    window.getAttachedFiles = function () { return attachFiles; };
    window.clearAttachments = clearAttachments;

    renderAttachments();
  }

  // ══ 3. Форма заявки ══
  // Состояние: idle → submitting → success | partial | error.
  var state = {
    submitting: false,
    requestId: null,   // живёт до терминального состояния: ретрай не создаёт дубль
    turnstileToken: '',
    turnstileWidget: null
  };

  var FIELDS = [
    {
      key: 'name', input: 'order-name', error: 'order-name-error',
      validate: function (v) {
        v = collapseWs(v);
        if (v.length < LIMITS.nameMin) return 'Укажите имя — от ' + LIMITS.nameMin + ' до ' + LIMITS.nameMax + ' символов';
        if (v.length > LIMITS.nameMax) return 'Имя слишком длинное — максимум ' + LIMITS.nameMax + ' символов';
        return '';
      }
    },
    {
      key: 'contact', input: 'order-contact', error: 'order-contact-error',
      validate: function (v) {
        v = collapseWs(v);
        if (v.length < LIMITS.contactMin) return 'Оставьте телефон или @username — от ' + LIMITS.contactMin + ' символов';
        if (v.length > LIMITS.contactMax) return 'Слишком длинный контакт — максимум ' + LIMITS.contactMax + ' символов';
        return '';
      }
    },
    {
      key: 'description', input: 'desc-input', error: 'desc-input-error',
      validate: function (v) {
        v = String(v || '').trim();
        if (v.length < LIMITS.descMin) return 'Опишите проект подробнее — минимум ' + LIMITS.descMin + ' символов';
        if (v.length > LIMITS.descMax) return 'Слишком длинное описание — максимум ' + LIMITS.descMax + ' символов';
        return '';
      }
    },
    {
      key: 'quantity', input: 'order-quantity', error: 'order-quantity-error',
      validate: function (v) {
        v = String(v || '').trim();
        if (v === '') return ''; // пусто → 1 копия (решает сервер)
        var n = Number(v);
        if (!Number.isInteger(n) || n < LIMITS.qtyMin || n > LIMITS.qtyMax) {
          return 'Количество — целое число от ' + LIMITS.qtyMin + ' до ' + LIMITS.qtyMax;
        }
        return '';
      }
    }
  ];

  function fieldByKey(key) {
    for (var i = 0; i < FIELDS.length; i++) if (FIELDS[i].key === key) return FIELDS[i];
    return null;
  }

  function setFieldError(field, message) {
    var input = $(field.input);
    var box = $(field.error);
    if (input) input.setAttribute('aria-invalid', 'true');
    if (box) {
      box.textContent = message;
      box.classList.remove('is-hidden');
    }
  }

  function clearFieldError(field) {
    var input = $(field.input);
    var box = $(field.error);
    if (input) input.removeAttribute('aria-invalid');
    if (box) {
      box.textContent = '';
      box.classList.add('is-hidden');
    }
  }

  function setStatus(message, kind) {
    var el = $('form-status');
    if (!el) return;
    el.textContent = message || '';
    el.className = 'form-status' + (kind ? ' is-' + kind : '');
  }

  function collectPayload() {
    return {
      name: collapseWs($('order-name') ? $('order-name').value : ''),
      contact: collapseWs($('order-contact') ? $('order-contact').value : ''),
      description: String($('desc-input') ? $('desc-input').value : '').trim(),
      material: $('order-material') ? $('order-material').value : '',
      color: collapseWs($('order-color') ? $('order-color').value : ''),
      quantity: String($('order-quantity') ? $('order-quantity').value : '').trim()
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
        if (!firstInvalid) firstInvalid = $(field.input);
      } else {
        clearFieldError(field);
      }
    });

    // Вложения: страховка перед отправкой (сервер проверяет то же самое).
    var filesError = '';
    if (attachFiles.length > LIMITS.maxFiles) {
      filesError = 'К заявке можно приложить максимум ' + LIMITS.maxFiles + ' файлов.';
    } else if (attachTotal() > LIMITS.maxTotalSize) {
      filesError = 'Общий размер вложений больше 40 МБ.';
    } else {
      for (var i = 0; i < attachFiles.length; i++) {
        if (attachFiles[i].size > LIMITS.maxFileSize) {
          filesError = 'Файл «' + attachFiles[i].name + '» больше 15 МБ.';
          break;
        }
        if (ALLOWED_EXT.indexOf(extOf(attachFiles[i].name)) === -1) {
          filesError = 'Формат файла «' + attachFiles[i].name + '» не поддерживается.';
          break;
        }
      }
    }
    if (filesError) setAttachNote(filesError, true);

    if (firstInvalid || filesError) {
      setStatus(
        'Проверьте форму: ' + (filesError ? filesError : 'несколько полей заполнены неверно.'),
        'error'
      );
      // Клавиатурного пользователя переводим к первой ошибке.
      var target = firstInvalid || $('attach-btn');
      if (target && target.focus) target.focus();
      return false;
    }

    setStatus('', '');
    return true;
  }

  function buildFormData(payload, requestId) {
    var fd = new FormData();
    fd.append('name', payload.name);
    fd.append('contact', payload.contact);
    fd.append('description', payload.description);
    fd.append('material', payload.material);
    fd.append('color', payload.color);
    fd.append('quantity', payload.quantity);
    fd.append('request_id', requestId);
    fd.append('honeypot', $('website') ? $('website').value : '');
    if (state.turnstileToken) fd.append('cf-turnstile-response', state.turnstileToken);
    attachFiles.forEach(function (f) { fd.append('files', f, f.name); });
    return fd;
  }

  /** Один POST. HTTP-код и status приводим к одному словарю состояний. */
  function postOrder(fd) {
    return fetch(WORKER_URL + '/api/order', { method: 'POST', body: fd }).then(function (res) {
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
  function submitWithRetry(fd, attempt) {
    return postOrder(fd)
      .catch(function () { return { status: 'network', http: 0, data: {} }; })
      .then(function (result) {
        if (result.status === 'pending' && attempt < PENDING_RETRIES) {
          setStatus('Заявка уже обрабатывается, ждём подтверждения…', 'info');
          return delay(PENDING_DELAY).then(function () {
            return submitWithRetry(fd, attempt + 1);
          });
        }
        return result;
      });
  }

  function setSubmitting(on) {
    state.submitting = on;
    var btn = document.querySelector('#order-form .btn-submit');
    var form = $('order-form');
    if (btn) {
      if (on) {
        btn.dataset.label = btn.textContent;
        btn.textContent = 'Отправляем…';
        btn.disabled = true;
        btn.setAttribute('aria-busy', 'true');
      } else {
        btn.textContent = btn.dataset.label || 'Отправить заявку';
        btn.disabled = false;
        btn.removeAttribute('aria-busy');
      }
    }
    if (form) form.setAttribute('aria-busy', on ? 'true' : 'false');
  }

  function showSuccess(kind, data) {
    var header = $('form-header');
    var form = $('order-form');
    var success = $('form-success');
    if (!success || !form) return;

    if (header) header.classList.add('hidden');
    form.classList.add('is-hidden');

    var icon = $('form-success-icon');
    var title = $('form-success-title');
    var text = $('form-success-text');
    var orderEl = $('form-success-order');
    var vkBtn = $('form-success-vk');

    if (kind === 'partial') {
      if (icon) icon.textContent = '⚠️';
      if (title) title.textContent = 'Заявка принята, но без файлов';
      if (text) {
        text.textContent = data.message ||
          'Текст заявки мы получили. Присланные файлы не дошли — отправьте их во ВКонтакте, пожалуйста.';
      }
      if (vkBtn) vkBtn.classList.remove('is-hidden');
    } else {
      if (icon) icon.textContent = '✅';
      if (title) title.textContent = 'Заявка отправлена!';
      if (text) text.textContent = 'Свяжемся с вами. Проверьте Telegram или телефон.';
      if (vkBtn) vkBtn.classList.add('is-hidden');
    }

    if (orderEl) {
      if (data.order) {
        orderEl.textContent = 'Номер заявки: ' + data.order;
        orderEl.classList.remove('is-hidden');
      } else {
        orderEl.classList.add('is-hidden');
      }
    }

    success.classList.add('show');
    setStatus('', '');
    // Фокус переводим на сообщение, чтобы клавиатурный пользователь его услышал/увидел.
    if (success.focus) success.focus();

    // Вложения очищаем только когда всё доставлено: при partial они нужны для VK.
    if (kind !== 'partial') clearAttachments();

    if (kind !== 'partial') {
      setTimeout(hideSuccess, SUCCESS_AUTOHIDE);
    }
  }

  function hideSuccess() {
    var header = $('form-header');
    var form = $('order-form');
    var success = $('form-success');
    if (success) success.classList.remove('show');
    if (header) header.classList.remove('hidden');
    if (form) {
      form.classList.remove('is-hidden');
      form.reset();
    }
    clearAttachments();
    FIELDS.forEach(clearFieldError);
    setStatus('', '');
  }

  function showFailure(message, kind) {
    setStatus(message, kind || 'error');
  }

  function handleResult(result) {
    switch (result.status) {
      case 'success':
      case 'partial':
        // Терминальное состояние: следующий заказ получит новый request_id.
        state.requestId = null;
        try { localStorage.setItem('3dprint_last_order', String(Date.now())); } catch (e) {}
        showSuccess(result.status, result.data);
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
        var msg = known ? 'Проверьте подсвеченные поля.' : (result.data.error || 'Заявка отклонена. Проверьте форму.');
        showFailure(msg, 'error');
        var first = FIELDS.filter(function (f) { return fields[f.key]; })[0];
        if (first && $(first.input)) $(first.input).focus();
        break;
      }

      case 'ratelimited':
        showFailure(result.data.error || 'Слишком много заявок. Подождите час или напишите во ВКонтакте.', 'error');
        break;

      case 'rejected':
        // Telegram отказал — сообщение не доставлено, при повторной попытке
        // нужен НОВЫЙ request_id, иначе DO вернёт сохранённый отказ.
        state.requestId = null;
        showFailure(result.data.message || 'Telegram отклонил заявку. Попробуйте ещё раз или напишите во ВКонтакте.', 'error');
        break;

      case 'pending':
        // Дубликат всё ещё в обработке — request_id сохраняем, повтор не дублирует отправку.
        showFailure('Заявка уже отправляется. Подождите немного и не нажимайте «Отправить» ещё раз.', 'info');
        break;

      case 'network':
      case 'unknown':
      default:
        // Результат неизвестен: НЕ повторяем автоматически, request_id сохраняем,
        // чтобы ручная повторная попытка не создала вторую заявку в Telegram.
        showFailure(
          (result.data && result.data.message) ||
            'Ответ от сервера не получен. Заявка могла уйти — не отправляйте её повторно, напишите во ВКонтакте.',
          'error'
        );
        break;
    }
  }

  function initTurnstile(attempt) {
      var el = $('order-turnstile');
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
    // Двойной submit: отправка уже идёт — выходим.
    if (state.submitting) {
      event.preventDefault();
      return;
    }
    event.preventDefault();

    // Honeypot: бот заполнил скрытое поле — тихий «успех», POST не делаем.
    var honeypot = $('website');
    if (honeypot && honeypot.value.trim()) {
      showSuccess('success', {});
      return;
    }

    if (!validateForm()) return;

    if (TURNSTILE_SITE_KEY && !state.turnstileToken) {
      showFailure('Подтвердите, что вы не робот.', 'error');
      return;
    }

    // Мягкий клиентский лимит: не чаще одной заявки в 2 минуты.
    var last = 0;
    try { last = parseInt(localStorage.getItem('3dprint_last_order') || '0', 10); } catch (e) {}
    if (last && Date.now() - last < 120000) {
      showFailure('Вы уже отправляли заявку. Подождите 2 минуты или напишите во ВКонтакте.', 'info');
      return;
    }

    var payload = collectPayload();
    if (!state.requestId) state.requestId = uuidV4();
    var fd = buildFormData(payload, state.requestId);

    setSubmitting(true);
    setStatus('Отправляем заявку…', 'info');

    submitWithRetry(fd, 0).then(
      function (result) {
        handleResult(result);
        setSubmitting(false);
        // Turnstile-токен одноразовый: после неудачи берём новый.
        if (result.status !== 'success' && result.status !== 'partial') resetTurnstile();
      },
      function () {
        // Сюда попадаем только при неожиданной ошибке клиента — форму не теряем.
        showFailure('Не получилось отправить заявку. Проверьте связь и попробуйте снова.', 'error');
        setSubmitting(false);
        resetTurnstile();
      }
    );
  }

  function initForm() {
    var form = $('order-form');
    if (!form) return;

    // Живая очистка ошибки поля, как только пользователь начал исправлять.
    FIELDS.forEach(function (field) {
      var input = $(field.input);
      if (!input) return;
      input.addEventListener('input', function () {
        if (input.getAttribute('aria-invalid') === 'true' && !field.validate(input.value)) {
          clearFieldError(field);
        }
      });
    });

    // novalidate убран: без JS браузер сам заблокирует пустую отправку.
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
    initMaterialTips();
    initAttachments();
    initForm();
  });
})();
