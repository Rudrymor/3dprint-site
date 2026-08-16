// catalog.js — загрузка товаров из Google Sheets
// Замени SHEET_ID на ID своей таблицы (из URL)
const SHEET_ID = "YOUR_GOOGLE_SHEET_ID";
const SHEET_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json`;

async function loadCatalog() {
  try {
    const res = await fetch(SHEET_URL);
    const text = await res.text();
    const json = JSON.parse(text.substring(47, text.length - 2));
    const rows = json.table.rows;
    const cols = json.table.cols.map(c => c.label);

    const root = document.getElementById("catalog-root");
    if (!rows.length) return;

    root.innerHTML = "";
    const grid = document.createElement("div");
    grid.style.cssText = "display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:20px";

    rows.forEach(row => {
      const d = {};
      row.c.forEach((cell, i) => { d[cols[i]] = cell?.v || ""; });
      if (!d["Название"]) return;

      grid.innerHTML += `
        <div style="background:#12121a;border:1px solid #1e1e2e;border-radius:16px;overflow:hidden;transition:border-color .2s">
          <div style="aspect-ratio:4/3;background:#1a1a24;display:flex;align-items:center;justify-content:center;overflow:hidden">
            ${d["Фото"] ? `<img src="${d["Фото"]}" alt="${d["Название"]}" style="width:100%;height:100%;object-fit:cover">` : `<span style="font-size:40px;opacity:.3"></span>`}
          </div>
          <div style="padding:20px">
            <h3 style="font-family:'Unbounded',sans-serif;font-size:16px;font-weight:700;margin-bottom:8px">${d["Название"]}</h3>
            <p style="font-size:13px;color:#8888a0;margin-bottom:12px;line-height:1.5">${d["Описание"] || ""}</p>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              ${d["Цена S"] ? `<span style="padding:4px 10px;background:rgba(255,214,10,.1);color:#ffd60a;border-radius:6px;font-size:11px;font-weight:600">S: ${d["Цена S"]}</span>` : ""}
              ${d["Цена M"] ? `<span style="padding:4px 10px;background:rgba(255,214,10,.1);color:#ffd60a;border-radius:6px;font-size:11px;font-weight:600">M: ${d["Цена M"]}</span>` : ""}
              ${d["Цена L"] ? `<span style="padding:4px 10px;background:rgba(255,214,10,.1);color:#ffd60a;border-radius:6px;font-size:11px;font-weight:600">L: ${d["Цена L"]}</span>` : ""}
            </div>
          </div>
        </div>`;
    });

    root.appendChild(grid);
  } catch (e) {
    console.warn("Каталог не загружен:", e);
  }
}

if (document.getElementById("catalog-root")) loadCatalog();
