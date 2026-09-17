// validators.ts — единый input contract для всех публичных endpoint'ов.
// Чистые функции без I/O. Используются Worker'ом (worker/src/index.ts).
// Клиент (order.html / reviews.html / scripts/*.js) должен соблюдать те же лимиты.

export const Limits = {
  // files
  maxFiles: 5,
  maxFileSize: 15 * 1024 * 1024,   // 15 МБ на файл
  maxTotalSize: 40 * 1024 * 1024,  // 40 МБ на всю заявку
  maxFilenameLen: 120,
  // bodies
  maxJsonBytes: 1024 * 1024,        // 1 МБ JSON body
  maxMultipartBytes: 50 * 1024 * 1024, // 50 МБ multipart (с overhead)
  maxMultipartFields: 20,
  // text
  textMin: 10,
  textMax: 10000,
  orderNameMin: 2,
  orderNameMax: 100,
  orderContactMin: 3,
  orderContactMax: 100,
  orderDescMin: 10,
  orderDescMax: 2000,
  orderColorMax: 100,
  orderQtyMin: 1,
  orderQtyMax: 999,
  reviewNameMax: 100,
  reviewTextMin: 10,
  reviewTextMax: 2000,
  // catalog
  catalogMaxItems: 100,
  catalogNameMax: 200,
  catalogDescMax: 1000,
  catalogFieldMax: 100, // material / price_* 
  // idempotency
  idempotencyTtl: 86400, // 24 ч в секундах
};

// ── request_id (UUID v4) ──
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Обязателен, формат UUID v4, длина ≤ 64. */
export function isRequestIdValid(value: unknown): boolean {
  return typeof value === 'string' && value.length <= 64 && UUID_V4_RE.test(value);
}

// ── text (заявка) ──
export function normalizeText(value: unknown, max = Limits.textMax): string {
  if (typeof value !== 'string') return '';
  return value.slice(0, max).trim();
}

// ── order (структурированные поля заявки, BUG-01) ──
// Сервер получает отдельные поля, а НЕ готовую Telegram-строку: иначе клиент
// (или любой, кто подделает запрос) полностью контролирует текст сообщения.
export const ORDER_MATERIALS = new Set(['PLA', 'PETG', 'ABS', 'other']);

export type OrderInput = {
  name: string;
  contact: string;
  description: string;
  material: string;
  color: string;
  quantity: number;
};

/**
 * Однострочное поле: переводы строк и табы схлопываются в пробел, повторы
 * пробелов убираются. Так пользователь не может вставить в имя/контакт
 * поддельную служебную строку («📎 Файлы: нет») — текст для Telegram
 * собирает сервер из проверенных значений.
 */
export function singleLine(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, max);
}

/** Описание — многострочное: сохраняем абзацы, но убираем \r и длинные пустоты. */
export function normalizeDescription(value: unknown, max = Limits.orderDescMax): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+$/gm, '')
    .trim()
    .slice(0, max);
}

export type OrderFieldErrors = Record<string, string>;

/**
 * Валидирует структурированные поля заявки. Возвращает нормализованные данные
 * либо карту ошибок по полям (клиент показывает их рядом с конкретным полем).
 */
export function validateOrder(input: unknown):
  | { ok: true; data: OrderInput }
  | { ok: false; fields: OrderFieldErrors } {
  const b: Record<string, unknown> =
    input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const fields: OrderFieldErrors = {};

  const name = singleLine(b.name, Limits.orderNameMax);
  if (name.length < Limits.orderNameMin) {
    fields.name = `Укажите имя (от ${Limits.orderNameMin} до ${Limits.orderNameMax} символов)`;
  }

  const contact = singleLine(b.contact, Limits.orderContactMax);
  if (contact.length < Limits.orderContactMin) {
    fields.contact = `Укажите телефон или Telegram (от ${Limits.orderContactMin} до ${Limits.orderContactMax} символов)`;
  }

  const description = normalizeDescription(b.description);
  if (description.length < Limits.orderDescMin) {
    fields.description = `Опишите проект подробнее — минимум ${Limits.orderDescMin} символов`;
  }

  // Материал необязателен, но если указан — только из allowlist.
  let material = '';
  if (b.material !== undefined && b.material !== null && String(b.material) !== '') {
    material = singleLine(b.material, 20);
    if (!ORDER_MATERIALS.has(material)) {
      fields.material = 'Неизвестный материал';
    }
  }

  const color = singleLine(b.color, Limits.orderColorMax);

  // Количество: отсутствует → 1; иначе строгий целый int в диапазоне.
  let quantity = 1;
  if (b.quantity !== undefined && b.quantity !== null && String(b.quantity) !== '') {
    const raw = typeof b.quantity === 'string' ? b.quantity.trim() : b.quantity;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < Limits.orderQtyMin || n > Limits.orderQtyMax) {
      fields.quantity = `Количество — целое число от ${Limits.orderQtyMin} до ${Limits.orderQtyMax}`;
    } else {
      quantity = n;
    }
  }

  if (Object.keys(fields).length > 0) return { ok: false, fields };
  return { ok: true, data: { name, contact, description, material, color, quantity } };
}

// ── review ──
export type ReviewInput = { name: string; text: string; rating: number };
export type ReviewError = { status: number; message: string };

/**
 * Валидирует объект отзыва. Возвращает нормализованные name/text/rating
 * либо ошибку с предсказуемым 4xx статусом.
 */
export function validateReview(input: unknown): { ok: true; data: ReviewInput } | { ok: false; error: ReviewError } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: { status: 400, message: 'Request body must be a JSON object' } };
  }
  const b = input as Record<string, unknown>;

  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (name.length < 2 || name.length > Limits.reviewNameMax) {
    return { ok: false, error: { status: 400, message: 'Name must be 2-100 characters' } };
  }

  const text = typeof b.text === 'string' ? b.text.trim() : '';
  if (text.length < Limits.reviewTextMin || text.length > Limits.reviewTextMax) {
    return { ok: false, error: { status: 400, message: 'Review text must be 10-2000 characters' } };
  }

  // rating: целое 1..5. Отсутствует/невалиден → 5 (как раньше), но строгий инт.
  let rating = 5;
  if (b.rating !== undefined && b.rating !== null) {
    const n = Number(b.rating);
    if (!Number.isInteger(n) || n < 1 || n > 5) {
      return { ok: false, error: { status: 400, message: 'Rating must be an integer 1-5' } };
    }
    rating = n;
  }

  return { ok: true, data: { name, text, rating } };
}

// ── files ──
// Должен СОВПАДАТЬ с accept в order.html: 
// .stl,.obj,.3mf,.step,.stp,.igs,.iges,.dwg,.f3d,.zip,.rar,.pdf,.jpg,.jpeg,.png,.webp,.heic,.gif
export const ALLOWED_EXTENSIONS = new Set([
  'stl', 'obj', '3mf', 'step', 'stp', 'igs', 'iges', 'dwg', 'f3d',
  'zip', 'rar', 'pdf', 'jpg', 'jpeg', 'png', 'webp', 'heic', 'gif',
]);

// MIME для расширений, у которых он стабилен. Для 3D/архивных форматов
// браузеры часто шлют application/octet-stream или пустую строку — поэтому
// авторитетным является РАСШИРЕНИЕ; MIME проверяем дополнительно (SEC-03).
const ALLOWED_MIME = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic',
  'application/pdf', 'application/zip', 'application/x-rar-compressed',
  'application/octet-stream', 'text/plain',
]);

export function fileExtension(filename: string): string {
  const base = filename.replace(/\\/g, '/').split('/').pop() || '';
  const i = base.lastIndexOf('.');
  return i === -1 ? '' : base.slice(i + 1).toLowerCase();
}

export type FileValidation =
  | { ok: true; cleanName: string }
  | { ok: false; status: number; message: string };

/**
 * Валидация одного файла. Расширение — из allowlist (всегда, даже при пустом
 * MIME). MIME — дополнительно: если задан и не octet-stream — должен быть
 * разрешён. Имя обрезается до безопасной длины.
 */
export function validateFile(file: { name: string; type: string; size: number }): FileValidation {
  const ext = fileExtension(file.name);
  if (!ext || !ALLOWED_EXTENSIONS.has(ext)) {
    return { ok: false, status: 415, message: 'Disallowed file type: .' + (ext || 'unknown') };
  }
  const type = file.type || '';
  if (type && type !== 'application/octet-stream' && !ALLOWED_MIME.has(type)) {
    return { ok: false, status: 415, message: 'Disallowed MIME type: ' + type };
  }
  const cleanName = file.name.slice(0, Limits.maxFilenameLen);
  if (!cleanName.trim()) {
    return { ok: false, status: 415, message: 'Empty file name' };
  }
  return { ok: true, cleanName };
}

/**
 * Валидирует массив файлов целиком: количество, размеры, каждый файл.
 * Возвращает список нормализованных имён (для sendDocument) или ошибку.
 */
export function validateFiles(files: Array<{ name: string; type: string; size: number }>):
  | { ok: true; fileNames: Array<{ name: string; size: number }> }
  | { ok: false; status: number; message: string } {
  if (files.length > Limits.maxFiles) {
    return { ok: false, status: 413, message: 'Too many files (max ' + Limits.maxFiles + ')' };
  }
  const total = files.reduce((s, f) => s + f.size, 0);
  if (total > Limits.maxTotalSize) {
    return { ok: false, status: 413, message: 'Total file size too large (max 40 MB)' };
  }
  const names: Array<{ name: string; size: number }> = [];
  for (const f of files) {
    if (f.size > Limits.maxFileSize) {
      return { ok: false, status: 413, message: 'File too large (max 15 MB)' };
    }
    if (f.size <= 0) continue; // пустые файлы пропускаем
    const v = validateFile(f);
    if (!v.ok) return { ok: false, status: v.status, message: v.message };
    names.push({ name: v.cleanName, size: f.size });
  }
  return { ok: true, fileNames: names };
}

// ── multipart field count ──
export function tooManyFields(entries: number): boolean {
  return entries > Limits.maxMultipartFields;
}

// ── catalog payload (DATA-01) ──
export function isSafeImageUrl(url: unknown): boolean {
  if (typeof url !== 'string' || !url) return false;
  if (!url.startsWith('images/')) return false;
  if (url.includes('..')) return false;
  if (url.length > 200) return false;
  if (/^(https?:|javascript:|data:|\/\/)/i.test(url)) return false;
  if (!/^images\/[a-zA-Z0-9_\-.]+\.(jpg|jpeg|png|gif|webp|svg)$/i.test(url)) return false;
  return true;
}

const CATEGORIES = new Set(['techno', 'decor']);

function validateCatalogItem(item: unknown): boolean {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
  const b = item as Record<string, unknown>;
  if (typeof b.name !== 'string' || b.name.trim() === '' || b.name.trim().length > Limits.catalogNameMax) return false;
  // description опционален — строка (в т.ч. пустая) или отсутствует
  if (b.description !== undefined && b.description !== null && typeof b.description !== 'string') return false;
  if (typeof b.description === 'string' && b.description.length > Limits.catalogDescMax) return false;
  if (b.category !== undefined && b.category !== null && b.category !== '' && !CATEGORIES.has(b.category as string)) return false;
  if (b.id !== undefined && b.id !== null && (!Number.isInteger(b.id) || (b.id as number) < 0)) return false;
  if (b.image !== undefined && b.image !== null && typeof b.image !== 'string') return false;
  if (b.image && typeof b.image === 'string' && !isSafeImageUrl(b.image)) return false;
  for (const f of ['material', 'price_s', 'price_m', 'price_l']) {
    if (b[f] !== undefined && b[f] !== null && typeof b[f] !== 'string') return false;
    if (typeof b[f] === 'string' && b[f].length > Limits.catalogFieldMax) return false;
  }
  return true;
}

/**
 * Валидирует catalog payload из KV. Отбрасывает битые записи (defense-in-depth),
 * чтобы одна повреждённая запись не ломала весь каталог. Проверяет лимиты.
 */
export function validateCatalogPayload(raw: unknown):
  | { ok: true; items: unknown[] }
  | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'Catalog payload must be an object' };
  }
  const b = raw as Record<string, unknown>;
  if (!Array.isArray(b.items)) {
    return { ok: false, error: 'Catalog payload must contain items array' };
  }
  const items = b.items;
  if (items.length > Limits.catalogMaxItems) {
    return { ok: false, error: 'Catalog too large (max ' + Limits.catalogMaxItems + ' items)' };
  }
  // Уникальные целочисленные ID
  const seen = new Set<number>();
  for (const it of items) {
    if (it && typeof it === 'object' && !Array.isArray(it) && Number.isInteger((it as Record<string, unknown>).id)) {
      const id = (it as Record<string, unknown>).id as number;
      if (seen.has(id)) return { ok: false, error: 'Duplicate catalog item id: ' + id };
      seen.add(id);
    }
  }
  const valid = items.filter(validateCatalogItem);
  return { ok: true, items: valid };
}