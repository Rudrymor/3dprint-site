// common.js — общие утилиты для всех страниц
// Подключается на index.html, works.html, order.html

// ─── XSS PROTECTION ───
// Экранирование HTML для безопасной вставки пользовательских данных
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ─── MOBILE NAV ───
function initMobileNav() {
  const toggle = document.querySelector('.nav-toggle');
  const links = document.querySelector('.nav-links');
  
  if (!toggle || !links) return;
  
  toggle.addEventListener('click', () => {
    links.classList.toggle('open');
    const isOpen = links.classList.contains('open');
    toggle.setAttribute('aria-expanded', isOpen);
  });
  
  // Закрыть меню при клике на ссылку
  links.querySelectorAll('.nav-link').forEach(link => {
    link.addEventListener('click', () => {
      links.classList.remove('open');
      toggle.setAttribute('aria-expanded', 'false');
    });
  });
  
  // Закрыть меню при клике вне
  document.addEventListener('click', (e) => {
    if (!e.target.closest('nav') && links.classList.contains('open')) {
      links.classList.remove('open');
      toggle.setAttribute('aria-expanded', 'false');
    }
  });
}

// ─── ЗАПУСК ───
document.addEventListener('DOMContentLoaded', () => {
  initMobileNav();
});
