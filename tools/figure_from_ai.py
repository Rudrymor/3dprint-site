#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Готовит ассет для hero из картинки, которую вернул AI (FLUX.2 klein и т.п.).

Порядок:
 1. отделяет фигурку от фона — заливкой от углов с допуском по цвету
    либо порогом по Оцу; метод выбирается автоматически по правдоподобности пропорций;
 2. заполняет только те внутренние дыры, что НЕ цвета фона (тёмные очки и кепка — да,
    просвет между лапами — нет, он остаётся прозрачным);
 3. снимает кайму: цвет кромки берётся у ближайшего внутреннего пикселя (defringe),
    иначе на тёмном фоне видно светлую окантовку от фона;
 4. мягкая альфа через знаковое расстояние: 0 снаружи, 255 внутри, переход ~3 px;
 5. пишет webp с альфой + превью на тёмном фоне сайта (#0f0f0f);
 6. предупреждает, если фигурка упирается в край кадра.

Пример:
  python tools/figure_from_ai.py --in ai_out.png --out images/figure-hero.webp --height 593
  python tools/figure_from_ai.py --in ai_out.png --out tmp/a.webp --preview tmp/a_preview.png --method otsu

Кириллические пути — только через np.fromfile / imencode (см. README).
"""
import argparse
import os
import sys

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tool_common import ensure_parent_dir, float_range, int_range

BG = 15  # #0f0f0f — фон hero на сайте


def read_img(path):
    buf = np.fromfile(path, dtype=np.uint8)
    img = cv2.imdecode(buf, cv2.IMREAD_UNCHANGED)
    if img is None:
        raise SystemExit(f"не удалось прочитать: {path}")
    return img


def write_img(path, img, quality=92):
    ext = os.path.splitext(path)[1].lower() or ".png"
    params = [cv2.IMWRITE_WEBP_QUALITY, quality] if ext == ".webp" else []
    ok, buf = cv2.imencode(ext, img, params)
    if not ok:
        raise SystemExit(f"не удалось закодировать: {path}")
    ensure_parent_dir(path)          # новый путь вывода не должен падать на записи
    buf.tofile(path)
    return len(buf)


def bg_color(img_bgr, k=None):
    h, w = img_bgr.shape[:2]
    k = k or max(4, min(h, w) // 25)
    corners = np.vstack([
        img_bgr[:k, :k].reshape(-1, 3), img_bgr[:k, -k:].reshape(-1, 3),
        img_bgr[-k:, :k].reshape(-1, 3), img_bgr[-k:, -k:].reshape(-1, 3),
    ]).astype(np.float32)
    return np.median(corners, axis=0)


def segment(img_bgr, thr=None, blur=6, method="auto", tol=None):
    """Маска фигурки. method: auto | border | otsu."""
    h, w = img_bgr.shape[:2]
    bg = bg_color(img_bgr)

    if method == "auto":
        cands = []
        for mth in ("otsu", "border"):
            try:
                mm, _, tthr = segment(img_bgr, thr, blur, mth, tol)
            except SystemExit:
                continue
            if int(mm.sum()) == 0:             # этот метод не нашёл ничего — не кандидат
                continue
            x, y, ww, hh = cv2.boundingRect(mm)
            if ww <= 0 or hh <= 0:             # вырожденный силуэт: пропорции считать не из чего
                continue
            ratio = ww / max(1, hh)
            area = float(mm.mean())
            edges = sum([y <= 1, y + hh >= h - 1, x <= 1, x + ww >= w - 1])
            bad = 0
            if not (0.33 < ratio < 0.68):
                bad += 1
            if not (0.03 < area < 0.45):
                bad += 1
            if edges > 1:                      # фигурка стоит по центру: край максимум один
                bad += 1
            score = bad * 10 + abs(ratio - 0.50) + edges * 0.2
            cands.append((score, mm, tthr, mth, ratio, area, edges))
        if not cands:
            raise SystemExit(
                "не удалось отделить фигурку от фона — проверь картинку\n"
                "  подсказка: --method border|otsu, --thr вручную, меньший --blur"
            )
        cands.sort(key=lambda c: c[0])
        _, m, tthr, used, ratio, area, edges = cands[0]
        print(f"  метод: {used}, ratio {ratio:.2f}, площадь {area * 100:.1f}%, краёв кадра {edges}")
        return m, bg, tthr

    if method == "otsu":
        dist = np.linalg.norm(img_bgr.astype(np.float32) - bg, axis=2)
        if blur:
            dist = cv2.GaussianBlur(dist, (0, 0), sigmaX=blur)
        d8 = np.clip(dist * 2.0, 0, 255).astype(np.uint8)
        t, _ = cv2.threshold(d8, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        tthr = thr if thr is not None else max(10.0, float(t) / 2.0)
        m = (dist > tthr).astype(np.uint8)
    else:
        m, tthr, best = None, 0.0, None
        for t in ([tol] if tol else [12, 20, 32, 48, 70]):
            flood = img_bgr.copy()
            fm = np.zeros((h + 2, w + 2), np.uint8)
            d = (int(t), int(t), int(t))
            for seed in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]:
                cv2.floodFill(flood, fm, seed, (0, 0, 0), d, d, cv2.FLOODFILL_FIXED_RANGE | 4)
            fig = (~(fm[1:-1, 1:-1] > 0)).astype(np.uint8)
            n, lab, stats, _ = cv2.connectedComponentsWithStats(fig, 8)
            if n <= 1:
                continue
            idx = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
            comp = (lab == idx).astype(np.uint8)
            x, y, ww, hh = cv2.boundingRect(comp)
            ratio = ww / max(1, hh)
            edges = sum([y <= 1, y + hh >= h - 1, x <= 1, x + ww >= w - 1])
            score = abs(ratio - 0.50) + edges * 0.15
            if best is None or score < best[0]:
                best = (score, comp, t)
        if best is None:
            raise SystemExit("заливка не справилась с фоном")
        _, m, tthr = best

    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8), iterations=1)
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8), iterations=2)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(m, 8)
    if n > 1:
        idx = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
        m = (lab == idx).astype(np.uint8)
    return m, bg, (tthr if tthr is not None else 0.0)


def check_mask(mask, min_area=400, min_side=12, aspect=(0.08, 12.0)):
    """Есть ли на маске фигурка. Возвращает bbox (x, y, w, h).

    Раньше на пустой маске (полностью чёрная или белая картинка) cv2.boundingRect
    отдавал 0x0, и масштаб делился на h = 0 — ZeroDivisionError с трейсбеком.
    Теперь отказ понятный и происходит до расчёта масштаба.
    """
    x, y, w, h = cv2.boundingRect(mask)
    area = int((mask > 0).sum())
    if area == 0 or w <= 0 or h <= 0:
        raise SystemExit(
            "фигурка не найдена: маска пустая.\n"
            "  проверь, что фигурка отличается от фона;\n"
            "  попробуй --method border или --thr вручную."
        )
    if area < min_area or min(w, h) < min_side:
        raise SystemExit(
            f"фигурка не найдена: слишком маленькое пятно ({w}x{h}px, {area} px площади).\n"
            f"  похоже, маска поймала мусор, а не фигурку; нужен силуэт от {min_side}px "
            f"и от {min_area} px площади."
        )
    what = w / h
    if not aspect[0] <= what <= aspect[1]:
        raise SystemExit(
            f"фигурка не найдена: неправдоподобные пропорции {w}x{h} "
            f"(ширина/высота {what:.2f}, ожидается {aspect[0]}..{aspect[1]})."
        )
    return x, y, w, h


def fill_inner_holes(mask, img_bgr, bg, tol=28):
    """Дыры внутри силуэта: заполняем только те, что НЕ цвета фона.

    Тёмные очки/кепка внутри белой фигурки — заполняем (часть фигурки).
    Просвет фона между лапами — оставляем прозрачным.
    """
    h, w = mask.shape
    filled = mask.copy()
    ff = np.zeros((h + 2, w + 2), np.uint8)
    cv2.floodFill(filled, ff, (0, 0), 1)
    # после заливки: фон, связанный с рамкой, стал 1; не залитыми (0) остались только дыры внутри силуэта
    holes = ((mask == 0) & (filled == 0)).astype(np.uint8)
    if not holes.any():
        return mask
    dist_bg = np.linalg.norm(img_bgr.astype(np.float32) - bg, axis=2)
    keep = holes & (dist_bg > tol)          # дыра не в цвет фона -> это часть фигурки
    return (mask | keep).astype(np.uint8)


def defringe(rgb, alpha, px=2):
    """Снимает кайму: цвет в полосе кромки берём у ближайшего внутреннего пикселя."""
    m = (alpha > 250).astype(np.uint8)
    if m.sum() == 0:
        return rgb
    inv = (1 - m).astype(np.uint8)
    _, labels = cv2.distanceTransformWithLabels(inv, cv2.DIST_L2, 5,
                                                labelType=cv2.DIST_LABEL_PIXEL)
    ys, xs = np.where(m)
    lut = np.zeros(int(labels.max()) + 1, dtype=np.int32)
    lut[labels[ys, xs]] = ys.astype(np.int32) * rgb.shape[1] + xs.astype(np.int32)
    src = lut[labels].reshape(-1)
    near = rgb.reshape(-1, 3)[src].reshape(rgb.shape)
    band = cv2.dilate(m, np.ones((2 * px + 1, 2 * px + 1), np.uint8)) > 0
    out = rgb.copy()
    out[band] = near[band]
    return out


def soft_matte(mask, ss=4, ramp=1.4):
    """alpha = 0.5 + signed_dist/(2*ramp): ровно 0 снаружи, ровно 255 внутри."""
    h, w = mask.shape
    big = cv2.resize(mask * 255, (w * ss, h * ss), interpolation=cv2.INTER_LINEAR)
    binb = (big > 127).astype(np.uint8)
    d_in = cv2.distanceTransform(binb, cv2.DIST_L2, 5)
    d_out = cv2.distanceTransform(1 - binb, cv2.DIST_L2, 5)
    a_big = np.clip(0.5 + (d_in - d_out) / (2.0 * max(0.5, ramp) * ss), 0, 1)
    return cv2.resize((a_big * 255).astype(np.uint8), (w, h), interpolation=cv2.INTER_AREA)


def main():
    ap = argparse.ArgumentParser(description="AI-картинка -> готовый ассет фигурки для hero")
    ap.add_argument("--in", dest="src", required=True)
    ap.add_argument("--out", dest="dst", required=True)
    ap.add_argument("--height", type=int_range(16, 8000, "--height"), default=593,
                    help="высота итогового ассета, px")
    ap.add_argument("--thr", type=float_range(0, 255, "--thr"), default=None,
                    help="порог отделения от фона (по умолчанию — авто)")
    ap.add_argument("--blur", type=int_range(0, 200, "--blur"), default=6,
                    help="размытие карты расстояний перед порогом, px")
    ap.add_argument("--method", choices=["auto", "border", "otsu"], default="auto")
    ap.add_argument("--pad", type=int_range(0, 500, "--pad"), default=0,
                    help="поле вокруг фигурки в итоговом ассете")
    ap.add_argument("--erode", type=int_range(0, 50, "--erode"), default=1,
                    help="сжатие маски, px: убирает кайму от фона")
    ap.add_argument("--defringe", type=int_range(0, 50, "--defringe"), default=2,
                    help="ширина полосы снятия каймы, px (0 — выкл.)")
    ap.add_argument("--hole-tol", type=int_range(0, 255, "--hole-tol"), default=28,
                    help="порог «дыра не цвета фона»")
    ap.add_argument("--preview", default=None, help="куда сохранить превью на тёмном фоне")
    ap.add_argument("--preview-light", default=None, help="превью на светлом фоне (проверка каймы)")
    ap.add_argument("--quality", type=int_range(1, 100, "--quality"), default=92)
    args = ap.parse_args()

    img = read_img(args.src)
    if img.ndim == 2:
        img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    if img.shape[2] == 4:
        img = cv2.cvtColor(img, cv2.COLOR_BGRA2BGR)

    mask, bg, thr = segment(img, args.thr, args.blur, args.method)
    mask = fill_inner_holes(mask, img, bg, args.hole_tol)
    if args.erode:
        mask = cv2.erode(mask, np.ones((3, 3), np.uint8), iterations=args.erode)
        n, lab, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
        if n > 1:
            idx = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
            mask = (lab == idx).astype(np.uint8)

    x, y, w, h = check_mask(mask)
    alpha = soft_matte(mask)

    H, W = img.shape[:2]
    touch = [n for n, cond in (("верх", y <= 1), ("низ", y + h >= H - 1),
                               ("левый край", x <= 1), ("правый край", x + w >= W - 1)) if cond]

    scale = args.height / h
    tw, th = max(1, int(round(w * scale))), args.height
    rgb = cv2.resize(img[y:y + h, x:x + w], (tw, th), interpolation=cv2.INTER_AREA)
    al = cv2.resize(alpha[y:y + h, x:x + w], (tw, th), interpolation=cv2.INTER_AREA)
    if args.defringe:
        rgb = defringe(rgb, al, args.defringe)

    if args.pad:
        rgb = cv2.copyMakeBorder(rgb, args.pad, args.pad, args.pad, args.pad,
                                 cv2.BORDER_CONSTANT, value=(BG, BG, BG))
        al = cv2.copyMakeBorder(al, args.pad, args.pad, args.pad, args.pad,
                                cv2.BORDER_CONSTANT, value=0)

    out = np.dstack([rgb, al]).astype(np.uint8)
    n = write_img(args.dst, out, args.quality)
    print(f"фон-образец: {bg.astype(int).tolist()}  порог: {thr:.1f}")
    print(f"фигурка: {w}x{h} -> {tw}x{th}  (defringe {args.defringe}px, erode {args.erode}px)")
    if touch:
        print(f"ВНИМАНИЕ: фигурка упирается в край кадра — {', '.join(touch)}")
    print(f"сохранено: {args.dst} ({n // 1024} КБ, {out.shape[1]}x{out.shape[0]})")

    for path, bgcol, tag in ((args.preview, BG, "тёмном"), (args.preview_light, 245, "светлом")):
        if not path:
            continue
        a = al.astype(np.float32)[..., None] / 255.0
        flat = (rgb.astype(np.float32) * a + np.array(bgcol, np.float32) * (1 - a)).astype(np.uint8)
        write_img(path, flat)
        print(f"превью на {tag} фоне: {path}")


if __name__ == "__main__":
    main()
