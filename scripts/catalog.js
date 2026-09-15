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

// ─── ВАЛИДАЦИЯ URL ИЗОБРАЖЕНИЯ ───
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

    var imgContainer = document.createElement("div");
    imgContainer.className = "catalog-card-img";

    if (img && isSafeImageUrl(img)) {
      var imgEl = document.createElement("img");
      imgEl.src = img;
      imgEl.alt = name;
      imgEl.loading = "lazy";
      imgContainer.appendChild(imgEl);
    } else if (img && !isSafeImageUrl(img)) {
      // Blocked potentially malicious URL
      console.warn("Catalog: blocked unsafe image URL:", img);
      var placeholder = document.createElement("span");
      placeholder.style.fontSize = "40px";
      placeholder.style.opacity = ".3";
      placeholder.textContent = "🖨️";
      imgContainer.appendChild(placeholder);
    } else {
      var placeholder = document.createElement("span");
      placeholder.style.fontSize = "40px";
      placeholder.style.opacity = ".3";
      placeholder.textContent = "🖨️";
      imgContainer.appendChild(placeholder);
    }

    var body = document.createElement("div");
    body.className = "catalog-card-body";

    var title = document.createElement("h3");
    title.className = "catalog-card-title";
    title.textContent = item.name || "";

    var descEl = document.createElement("p");
    descEl.className = "catalog-card-desc";
    descEl.textContent = item.description || "";

    body.appendChild(title);
    body.appendChild(descEl);
    card.appendChild(imgContainer);
    card.appendChild(body);
    root.appendChild(card);
  });
}

// ─── ЛАЙТБОКС ───
function initLightbox() {
  var imgs = Array.from(document.querySelectorAll('.catalog-card-img img'));
  if (!imgs.length) return;

  var idx = 0;
  var box = document.createElement('div');
  box.className = 'lightbox';
  box.innerHTML =
    '<button class="lb-btn lb-close" aria-label="Закрыть">×</button>' +
    '<button class="lb-btn lb-prev" aria-label="Предыдущая">‹</button>' +
    '<img class="lb-img" src="" alt="">' +
    '<button class="lb-btn lb-next" aria-label="Следующая">›</button>' +
    '<div class="lb-caption"></div>';
  document.body.appendChild(box);

  var imgEl = box.querySelector('.lb-img');
  var capEl = box.querySelector('.lb-caption');

  function show(i) {
    idx = (i + imgs.length) % imgs.length;
    var source = imgs[idx];
    var card = source.closest('.catalog-card');
    var title = card ? card.querySelector('.catalog-card-title') : null;
    imgEl.src = source.src;
    imgEl.alt = source.alt || (title ? title.textContent.trim() : '');
    capEl.innerHTML = title ? '<strong>' + escapeHtml(title.textContent.trim()) + '</strong>' : '';
  }

  function open(i) {
    show(i);
    box.classList.add('open');
    document.body.classList.add('lb-open');
  }

  function close() {
    box.classList.remove('open');
    document.body.classList.remove('lb-open');
  }

  imgs.forEach(function (im, i) { im.addEventListener('click', function () { open(i); }); });
  box.querySelector('.lb-close').addEventListener('click', close);
  box.querySelector('.lb-next').addEventListener('click', function (e) { e.stopPropagation(); show(idx + 1); });
  box.querySelector('.lb-prev').addEventListener('click', function (e) { e.stopPropagation(); show(idx - 1); });
  box.addEventListener('click', function (e) { if (e.target === box) close(); });

  document.addEventListener('keydown', function (e) {
    if (!box.classList.contains('open')) return;
    if (e.key === 'Escape') close();
    if (e.key === 'ArrowRight') show(idx + 1);
    if (e.key === 'ArrowLeft') show(idx - 1);
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
  initLightbox();
}

// ─── ЗАПУСК ───
loadCatalog();
