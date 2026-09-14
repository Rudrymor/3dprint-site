// seed-catalog.js — засеивает KV начальными данными каталога
// Использовать: cd worker && npx wrangler kv key put --binding CATALOG_KV --key catalog "$(node seed-catalog.js)"
// Или вручную через Dashboard: KV → catalog → JSON

const catalog = {
  "items": [
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
  ],
  "updated": new Date().toISOString()
};

// Вывод JSON для pipe в wrangler
process.stdout.write(JSON.stringify(catalog));
