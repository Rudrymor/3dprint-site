// reviews.js — отзывы клиентов
//
// КАК ДОБАВИТЬ ОТЗЫВ:
// Скопируй блок ниже (от { до }), вставь перед закрывающей ]; и измени данные.
// Пока массив пустой — секция отзывов на сайте скрыта.
// Добавишь первый отзыв — секция появится автоматически.
//
// ПОЛЯ:
//   name   — имя клиента (можно "Алексей К." или просто "Алексей")
//   text   — текст отзыва, живой и конкретный (что заказывал, как вышло)
//   stars  — оценка от 1 до 5
//   date   — когда (например "Август 2026")
//
// ПРИМЕР (раскомментируй и замени на реальный отзыв):
//   {
//     "name": "Алексей",
//     "text": "Заказывал кронштейн для крепления регистратора. Сделали за два дня, встал как родной.",
//     "stars": 5,
//     "date": "Август 2026"
//   },

const REVIEWS_DATA = [
  {
    "name": "Алексей",
    "text": "Заказывал чехол для ключа Audi — сделали быстро, встал как родной. Рекомендую!",
    "stars": 5,
    "date": "Август 2026"
  },
  {
    "name": "Марина",
    "text": "Печатали панель крепления для авто. Качество отличное, цена адекватная.",
    "stars": 5,
    "date": "Сентябрь 2026"
  }
];

// ─── ОТРИСОВКА ОТЗЫВОВ (список) ───
function renderReviews(items) {
  const section = document.getElementById("reviews-section");
  const root = document.getElementById("reviews-root");
  if (!section || !root) return;

  if (!items.length) {
    section.style.display = "none";
    return;
  }

  section.style.display = "";
  root.innerHTML = "";

  items.forEach(item => {
    const name = escapeHtml(item.name || "");
    const text = escapeHtml(item.text || "");
    const rating = Math.max(1, Math.min(5, parseInt(item.stars || item.rating, 10) || 5));
    const date = escapeHtml(item.date || "");
    const stars = "★".repeat(rating) + "☆".repeat(5 - rating);

    const row = document.createElement("div");
    row.className = "review-row";
    row.innerHTML =
      `<span class="review-row-name">${name}</span>` +
      `<span class="review-row-stars">${stars}</span>` +
      `<span class="review-row-text">${text}</span>` +
      `<span class="review-row-date">${date}</span>`;
    root.appendChild(row);
  });
}

// ─── ЗАПУСК ───
if (document.getElementById("reviews-root")) {
  var stored = [];
  try { stored = JSON.parse(localStorage.getItem('3dprint_reviews') || '[]'); } catch(e) {}
  var allReviews = (REVIEWS_DATA || []).concat(stored);
  renderReviews(allReviews);
}
