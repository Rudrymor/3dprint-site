// catalog.js — каталог товаров
// Загружается из Cloudflare KV через Worker API
// Если Worker недоступен — показывает пустой каталог с сообщением

var CATALOG_API = 'https://tg-proxy.metalkor91.workers.dev/api/catalog';

var CATALOG_DATA = [];

// ─── КАТЕГОРИИ ───
var CATEGORY_META = {
  techno: {
    title: "Инженерные и функциональные детали",
    sub: "Проектирование 3D модели по чертежу, эскизу или оригиналу для последующей 3D печати",
    label: "работ в этой подборке"
  },
  decor: {
    title: "Авторские 3D фигурки",
    sub: "Лимитированная коллекция",
    label: "работ в этой подборке"
  }
};

// ─── ОТРИСОВКА КАТАЛОГА ───
function renderCatalog(items) {
  var root = document.getElementById("catalog-root");
  if (!root) return;

  if (!items.length) {
    root.innerHTML = '<p style="text-align:center;color:#71717a;padding:40px 0;">Каталог загружается…</p>';
    return;
  }

  root.innerHTML = "";
  root.className = "catalog-grid";

  items.forEach(function (item) {
    var name = escapeHtml(item.name || "");
    var desc = escapeHtml(item.description || "");
    var img = item.image || "";

    var card = document.createElement("div");
    card.className = "catalog-card";

    var imgHtml = img
      ? '<img src="' + img + '" alt="' + name + '" loading="lazy">'
      : '<span style="font-size:40px;opacity:.3">🖨️</span>';

    card.innerHTML =
      '<div class="catalog-card-img">' + imgHtml + '</div>' +
      '<div class="catalog-card-body">' +
      '<h3 class="catalog-card-title">' + name + '</h3>' +
      '<p class="catalog-card-desc">' + desc + '</p>' +
      '</div>';
    root.appendChild(card);
  });
}

// ─── ВЫБОРКА ПО КАТЕГОРИИ ИЗ URL ───
function getCatalogView(items) {
  var cat = new URLSearchParams(location.search).get("cat");
  if (cat && CATEGORY_META[cat]) {
    return {
      cat: cat,
      items: items.filter(function (i) { return i.category === cat; }),
      meta: CATEGORY_META[cat]
    };
  }
  return { cat: "", items: items, meta: null };
}

// ─── ОБНОВЛЕНИЕ СЧЁТЧИКА И ЗАГОЛОВКА ───
function updatePage(view) {
  var countEl = document.getElementById("work-count");
  if (countEl) countEl.textContent = view.items.length;

  var labelEl = document.getElementById("work-count-label");
  if (labelEl && view.meta) labelEl.textContent = view.meta.label;

  if (view.meta) {
    var titleEl = document.getElementById("works-title");
    var subEl = document.getElementById("works-sub");
    if (titleEl) titleEl.textContent = view.meta.title;
    if (subEl) subEl.textContent = view.meta.sub;
    document.title = view.meta.title + " — 3DArtStudio";
  }
}

// ─── ЗАГРУЗКА ИЗ API ───
async function loadCatalog() {
  var root = document.getElementById("catalog-root");
  if (!root) return;

  try {
    var res = await fetch(CATALOG_API);
    if (!res.ok) throw new Error("HTTP " + res.status);
    var data = await res.json();
    CATALOG_DATA = data.items || [];
  } catch (e) {
    console.error("Catalog API error:", e);
    root.innerHTML = '<p style="text-align:center;color:#71717a;padding:40px 0;">Не удалось загрузить каталог. Попробуйте обновить страницу.</p>';
    return;
  }

  var view = getCatalogView(CATALOG_DATA);
  renderCatalog(view.items);
  updatePage(view);
}

// ─── ЗАПУСК ───
loadCatalog();
