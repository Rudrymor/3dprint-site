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
//   rating — оценка от 1 до 5
//   date   — когда (например "Август 2026")
//
// ПРИМЕР (раскомментируй и замени на реальный отзыв):
//   {
//     "name": "Алексей",
//     "text": "Заказывал кронштейн для крепления регистратора. Сделали за два дня, встал как родной.",
//     "rating": 5,
//     "date": "Август 2026"
//   },

const REVIEWS_DATA = [
];

// ─── ОТРИСОВКА ОТЗЫВОВ ───
function renderReviews(items) {
  const section = document.getElementById("reviews-section");
  const root = document.getElementById("reviews-root");
  if (!section || !root) return;

  // Нет отзывов — прячем всю секцию
  if (!items.length) {
    section.style.display = "none";
    return;
  }

  section.style.display = "";
  root.innerHTML = "";

  items.forEach(item => {
    const name = escapeHtml(item.name || "");
    const text = escapeHtml(item.text || "");
    const rating = Math.max(1, Math.min(5, parseInt(item.rating, 10) || 5));
    const date = escapeHtml(item.date || "");

    const stars = "★".repeat(rating) + "☆".repeat(5 - rating);

    const card = document.createElement("div");
    card.className = "review-card";
    card.innerHTML = `
      <div class="review-stars" aria-label="Оценка ${rating} из 5">${stars}</div>
      <p class="review-text">${text}</p>
      <div class="review-meta">
        <span class="review-name">${name}</span>
        ${date ? `<span class="review-date">${date}</span>` : ""}
      </div>
    `;
    root.appendChild(card);
  });
}

// ─── ЗАПУСК ───
if (document.getElementById("reviews-root")) {
  renderReviews(REVIEWS_DATA);
}
