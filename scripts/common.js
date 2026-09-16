// common.js — общие утилиты для всех страниц
// Подключается на index.html, works.html, order.html

// ─── XSS PROTECTION ───
// Экранирование HTML для безопасной вставки пользовательских данных
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ─── MOBILE NAV (sidebar left) ───
function initMobileNav() {
  const toggle = document.querySelector('.nav-toggle');
  const links = document.querySelector('.nav-links');
  
  if (!toggle || !links) return;
  
  // Create overlay if not exists
  let overlay = document.querySelector('.nav-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.className = 'nav-overlay';
    document.body.appendChild(overlay);
  }
  
  function openMenu() {
    links.classList.add('open');
    overlay.classList.add('active');
    toggle.setAttribute('aria-expanded', 'true');
  }
  
  function closeMenu() {
    links.classList.remove('open');
    overlay.classList.remove('active');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.focus();
  }
  
  toggle.addEventListener('click', () => {
    if (links.classList.contains('open')) {
      closeMenu();
    } else {
      openMenu();
    }
  });
  
  // Close on overlay click
  overlay.addEventListener('click', closeMenu);
  
  // Close on link click
  links.querySelectorAll('.nav-link, .logo').forEach(link => {
    link.addEventListener('click', closeMenu);
  });
  
  // Close on ESC
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && links.classList.contains('open')) {
      closeMenu();
    }
  });
}

// ─── ЗАПУСК ───
document.addEventListener('DOMContentLoaded', () => {
  initMobileNav();
});
