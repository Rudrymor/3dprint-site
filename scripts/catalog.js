// catalog.js — каталог товаров
// Данные встроены прямо сюда — работает и без сервера, и на GitHub Pages
//
// КАК ДОБАВИТЬ НОВЫЙ ПРОЕКТ:
// Скопируй блок ниже (от { до }), вставь перед закрывающей ]; и измени данные.
// category: "techno" = запчасти, крепления, технические детали
// category: "decor"  = игрушки, фигурки, декоративные элементы

const CATALOG_DATA = [
  {
    "id": 1,
    "name": "Чехол для ключа Audi",
    "description": "Защитный чехол для смарт-ключа Audi. Точная посадка, отверстие для кольца.",
    "image": "images/audi-cover.jpg",
    "category": "techno",
    "material": "PLA / PETG",
    "price_s": "450 ₽",
    "price_m": "",
    "price_l": ""
  },
  {
    "id": 2,
    "name": "Панель крепления Range Rover",
    "description": "Кронштейн-адаптер для установки доп. оборудования. Прочная конструкция с монтажными отверстиями.",
    "image": "images/rr-panel.jpg",
    "category": "techno",
    "material": "PETG / ABS",
    "price_s": "",
    "price_m": "890 ₽",
    "price_l": ""
  },
  {
    "id": 3,
    "name": "Защёлка Range Rover",
    "description": "Замена сломанной пластиковой защёлки. Точная копия оригинальной детали.",
    "image": "images/rr-latch.jpg",
    "category": "techno",
    "material": "Nylon / PETG",
    "price_s": "380 ₽",
    "price_m": "",
    "price_l": ""
  },
  {
    "id": 4,
    "name": "Композитная шестерня",
    "description": "Двойная шестерня для редуктора. Два разных диаметра на одном валу.",
    "image": "images/gear.jpg",
    "category": "techno",
    "material": "PETG / ABS",
    "price_s": "320 ₽",
    "price_m": "580 ₽",
    "price_l": ""
  },
  {
    "id": 5,
    "name": "Сказочный домик-ночник",
    "description": "Low-poly диорама с подсветкой. Парящий остров с домом, башней и ёлками.",
    "image": "images/toy-1.jpg",
    "category": "decor",
    "material": "PLA",
    "price_s": "680 ₽",
    "price_m": "1 200 ₽",
    "price_l": "1 800 ₽"
  },
  {
    "id": 6,
    "name": "Заглушка тормозного суппорта",
    "description": "Защитная заглушка для тормозного механизма. Предотвращает попадание грязи.",
    "image": "images/brake-plug.jpg",
    "category": "techno",
    "material": "TPU / PETG",
    "price_s": "280 ₽",
    "price_m": "",
    "price_l": ""
  },
  {
    "id": 7,
    "name": "Фланец Jetour",
    "description": "Монтажная пластина-фланец для автомобиля Jetour. Центральная бобышка с отверстием.",
    "image": "images/jetour-washer.jpg",
    "category": "techno",
    "material": "PETG / ABS",
    "price_s": "",
    "price_m": "420 ₽",
    "price_l": ""
  },
  {
    "id": 8,
    "name": "Клипса для лыжного крепления",
    "description": "Разрезной хомут-зажим для фиксации лыжных палок или снаряжения.",
    "image": "images/ski-clip.jpg",
    "category": "techno",
    "material": "PETG / Nylon",
    "price_s": "350 ₽",
    "price_m": "",
    "price_l": ""
  },
  {
    "id": 9,
    "name": "Защитный кожух для дрели",
    "description": "Эргономичный держатель с ручкой. Защищает руки при работе.",
    "image": "images/drill-guard.jpg",
    "category": "techno",
    "material": "PETG / ABS",
    "price_s": "",
    "price_m": "520 ₽",
    "price_l": ""
  },
  {
    "id": 10,
    "name": "Подставка для велосипеда",
    "description": "Настольная подставка-органайзер. Устойчивая трапециевидная форма.",
    "image": "images/bike-stand.jpg",
    "category": "techno",
    "material": "PLA / PETG",
    "price_s": "",
    "price_m": "480 ₽",
    "price_l": "720 ₽"
  },
  {
    "id": 11,
    "name": "Диорама «Похищение коровы»",
    "description": "Low-poly сцена: домик, хвойный лес и летающая тарелка с лучом над фермой.",
    "image": "images/toy-2.jpg",
    "category": "decor",
    "material": "PLA",
    "price_s": "",
    "price_m": "",
    "price_l": ""
  },
  {
    "id": 12,
    "name": "Фэнтези-воин с посохом",
    "description": "Коллекционная миниатюра: рогатый шлем, плащ и посох с навершием. Модель под покраску.",
    "image": "images/toy-3.jpg",
    "category": "decor",
    "material": "PLA",
    "price_s": "",
    "price_m": "",
    "price_l": ""
  }
];

// ─── ОТРИСОВКА КАТАЛОГА ───
function renderCatalog(items) {
  const root = document.getElementById("catalog-root");
  if (!root || !items.length) return;

  root.innerHTML = "";
  root.className = "catalog-grid";

  items.forEach(item => {
    const name = escapeHtml(item.name || "");
    const desc = escapeHtml(item.description || "");
    const img = item.image || "";

    const card = document.createElement("div");
    card.className = "catalog-card";
    
    const imgHtml = img 
      ? `<img src="${img}" alt="${name}" loading="lazy">`
      : '<span style="font-size:40px;opacity:.3">🖨️</span>';
    
    card.innerHTML = `
      <div class="catalog-card-img">
        ${imgHtml}
      </div>
      <div class="catalog-card-body">
        <h3 class="catalog-card-title">${name}</h3>
        <p class="catalog-card-desc">${desc}</p>
      </div>
    `;
    root.appendChild(card);
  });
}

// ─── ВЫБОРКА ПО КАТЕГОРИИ ИЗ URL ───
// works.html?cat=techno — инженерные детали, works.html?cat=decor — фигурки
// Без параметра показывается весь каталог.
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

var CATALOG_VIEW = (function () {
  var cat = new URLSearchParams(location.search).get("cat");
  if (cat && CATEGORY_META[cat]) {
    return {
      cat: cat,
      items: CATALOG_DATA.filter(function (i) { return i.category === cat; }),
      meta: CATEGORY_META[cat]
    };
  }
  return { cat: "", items: CATALOG_DATA, meta: null };
})();

// ─── ЗАПУСК ───
if (document.getElementById("catalog-root")) {
  renderCatalog(CATALOG_VIEW.items);

  // Счётчик работ — всегда по текущей выборке
  var countEl = document.getElementById("work-count");
  if (countEl) countEl.textContent = CATALOG_VIEW.items.length;

  var labelEl = document.getElementById("work-count-label");
  if (labelEl && CATALOG_VIEW.meta) labelEl.textContent = CATALOG_VIEW.meta.label;

  // Заголовок страницы под выбранную категорию
  if (CATALOG_VIEW.meta) {
    var titleEl = document.getElementById("works-title");
    var subEl = document.getElementById("works-sub");
    if (titleEl) titleEl.textContent = CATALOG_VIEW.meta.title;
    if (subEl) subEl.textContent = CATALOG_VIEW.meta.sub;
    document.title = CATALOG_VIEW.meta.title + " — 3DArtStudio";
  }
}
