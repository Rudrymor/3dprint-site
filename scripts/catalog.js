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
  }
];

// ─── ОТРИСОВКА КАТАЛОГА ───
function renderCatalog(items) {
  const root = document.getElementById("catalog-root");
  if (!root || !items.length) return;

  root.innerHTML = "";
  root.className = "catalog-grid";

  items.forEach(item => {
    const name = item.name || "";
    const desc = item.description || "";
    const img = item.image || "";
    const priceS = item.price_s || "";
    const priceM = item.price_m || "";
    const priceL = item.price_l || "";

    const card = document.createElement("div");
    card.className = "catalog-card";
    card.dataset.category = item.category || "";
    card.innerHTML = `
      <div class="catalog-card-img">
        ${img ? `<img src="${img}" alt="${name}" loading="lazy">` : '<span style="font-size:40px;opacity:.3">🖨️</span>'}
      </div>
      <div class="catalog-card-body">
        <h3 class="catalog-card-title">${name}</h3>
        <p class="catalog-card-desc">${desc}</p>
        <div class="catalog-card-prices">
          ${priceS ? `<span class="price-tag">${priceS}</span>` : ""}
          ${priceM ? `<span class="price-tag">${priceM}</span>` : ""}
          ${priceL ? `<span class="price-tag">${priceL}</span>` : ""}
        </div>
      </div>
    `;
    root.appendChild(card);
  });
}

// ─── ЗАПУСК ───
if (document.getElementById("catalog-root")) {
  renderCatalog(CATALOG_DATA);
}

// ─── ФИЛЬТРАЦИЯ ───
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.filter-btn');
  if (!btn) return;

  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');

  const filter = btn.dataset.filter;
  const cards = document.querySelectorAll('.catalog-card');

  cards.forEach(card => {
    const cat = card.dataset.category;
    if (filter === 'all' || cat === filter) {
      card.style.display = '';
    } else {
      card.style.display = 'none';
    }
  });
});
