// common.js — общие утилиты для всех страниц
// Подключается на index.html, works.html, order.html, reviews.html

// ─── XSS PROTECTION ───
// Экранирование HTML для безопасной вставки пользовательских данных
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ─── MOBILE NAV (sidebar left) ───
// Этап 7 (A11Y-03): aria-controls, ловушка фокуса, inert фона, Escape,
// возврат фокуса только при закрытии с клавиатуры/кнопкой.
function initMobileNav() {
  const toggle = document.querySelector('.nav-toggle');
  const links = document.querySelector('.nav-links');

  if (!toggle || !links) return;

  // Даём панели стабильный id, чтобы кнопка ссылалась на неё через aria-controls.
  if (!links.id) links.id = 'mobile-nav';
  toggle.setAttribute('aria-controls', links.id);
  if (!toggle.hasAttribute('aria-expanded')) {
    toggle.setAttribute('aria-expanded', 'false');
  }

  // Create overlay if not exists
  let overlay = document.querySelector('.nav-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.className = 'nav-overlay';
    document.body.appendChild(overlay);
  }

  let lastFocused = null;
  let bgInerted = [];

  function isOpen() {
    return links.classList.contains('open');
  }

  // Какие элементы умеют принимать фокус внутри открытого меню.
  function focusables() {
    const els = [toggle].concat(
      Array.from(links.querySelectorAll('a[href], button:not([disabled])'))
    );
    return els.filter((el) => el && !el.hasAttribute('hidden') && el.offsetParent !== null);
  }

  function setBackgroundInert(on) {
    // Снимаем прежние пометки.
    bgInerted.forEach((el) => {
      if (el && el.__navInert) {
        el.inert = false;
        el.__navInert = false;
      }
    });
    bgInerted = [];
    if (!on) return;
    // Фон под выдвижным меню: контент, подвал и плавающие кнопки.
    const bg = document.querySelectorAll('main, footer, .vk-float, .reviews-float');
    bg.forEach((el) => {
      if (!el.inert) {
        el.inert = true;
        el.__navInert = true;
        bgInerted.push(el);
      }
    });
  }

  function openMenu() {
    if (isOpen()) return;
    lastFocused = document.activeElement;
    links.classList.add('open');
    overlay.classList.add('active');
    toggle.setAttribute('aria-expanded', 'true');
    setBackgroundInert(true);
    // Фокус — на первую ссылку меню, чтобы клавиатурный пользователь сразу внутри.
    const first = links.querySelector('a[href], button:not([disabled])');
    if (first) first.focus();
  }

  function closeMenu(returnFocus) {
    if (!isOpen()) return;
    links.classList.remove('open');
    overlay.classList.remove('active');
    toggle.setAttribute('aria-expanded', 'false');
    setBackgroundInert(false);
    // Возвращаем фокус на кнопку только когда меню закрыли кнопкой/Escape/оверлеем,
    // но не при переходе по ссылке (там фокус уже ушёл за якорем).
    if (returnFocus && toggle) toggle.focus();
    lastFocused = null;
  }

  // Ловушка фокуса + Escape — один обработчик на документ.
  function onKeyDown(e) {
    if (!isOpen()) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      closeMenu(true);
      return;
    }
    if (e.key !== 'Tab') return;
    const items = focusables();
    if (items.length === 0) {
      e.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  toggle.addEventListener('click', () => {
    if (isOpen()) {
      closeMenu(true);
    } else {
      openMenu();
    }
  });

  // Close on overlay click (мышь — фокус возвращать не нужно)
  overlay.addEventListener('click', () => closeMenu(false));

  // Close on link click: переход по якорю, фокус остаётся у цели перехода
  links.querySelectorAll('.nav-link, .logo').forEach(link => {
    link.addEventListener('click', () => closeMenu(false));
  });

  document.addEventListener('keydown', onKeyDown);
}

// ─── ЗАПУСК ───
document.addEventListener('DOMContentLoaded', () => {
  initMobileNav();
});
