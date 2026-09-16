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

var REVIEWS_DATA = [
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
  var root = document.getElementById("reviews-root");
  var empty = document.getElementById("reviews-empty");
  if (!root) return;

  if (!items.length) {
    root.style.display = "none";
    if (empty) empty.style.display = "block";
    return;
  }

  root.style.display = "";
  if (empty) empty.style.display = "none";
  root.innerHTML = "";

  items.forEach(function(item) {
    var name = escapeHtml(item.name || "");
    var text = escapeHtml(item.text || "");
    var rating = Math.max(1, Math.min(5, parseInt(item.stars || item.rating, 10) || 5));
    var date = escapeHtml(item.date || "");
    var stars = "\u2605".repeat(rating) + "\u2606".repeat(5 - rating);

    var row = document.createElement("div");
    row.className = "review-row";
    row.innerHTML =
      '<span class="review-row-name">' + name + '</span>' +
      '<span class="review-row-stars">' + stars + '</span>' +
      '<span class="review-row-text">' + text + '</span>' +
      '<span class="review-row-date">' + date + '</span>';
    root.appendChild(row);
  });
}

// ─── ЗАГРУЗКА ОТЗЫВОВ ───
// Показываем только курированные отзывы из кода.
// Пользовательская форма отправляет отзыв в Telegram (владельцу), не публикует на сайте.
function loadReviews() {
  renderReviews(REVIEWS_DATA || []);
  return REVIEWS_DATA || [];
}

// ─── ЗАПУСК ───
if (document.getElementById("reviews-root")) {
  loadReviews();
}
