#!/usr/bin/env python3
"""
Готовит ассет для hero-фигурки на главной: вырез с фото + восстановление правого уха
+ покраска по зонам одежды.

Использование (из корня репозитория):
    python tools/figure_hero.py --in "игрушка.jpg" --out images/figure-hero.webp
    python tools/figure_hero.py --in "фото.jpg" --out images/figure-hero.webp --no-paint   # только вырез (для фото раскрашенной фигурки)
    python tools/figure_hero.py --no-ear                                                  # без восстановления уха

Как это работает:
  1. маска «ярко и не насыщенно» -> крупнейшая компонента -> срез тонких выступов внизу
     -> заливка дыр -> эрозия (снимает светлую кайму) -> мягкая кромка
  2. правое ухо: правая половина головы заменяется зеркальной копией левой
     (на исходном фото правое ухо закрыто рукой, левое видно целиком) — силуэт становится
     симметричным до пикселя
  3. покраска: изображение переводится в LAB, у каждой зоны (кепка, морда, худи, шорты,
     кроссовки, подошва) выставляется цвет, а канал светимости сохраняется — остаются блики
     и тени. Границы зон заданы в долях высоты фигурки; подол худи и верх кроссовок
     подобраны по профилю силуэта (там, где силуэт резко сужается/расширяется)

Цвета меняются в PALETTE — правь hex и перезапускай.
"""
import argparse
import os
import sys

import cv2
import numpy as np
from scipy import ndimage

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from figure_cutout import imread_unicode, largest_component, strip_thin_lower

# ── палитра: (имя, от % высоты, до % высоты, цвет) ──
PALETTE = [
    ("cap",     0.00, 0.300, "#ff6b35"),   # кепка + ушки
    ("face",    0.300, 0.500, "#e9dcc6"),  # мордочка (тёплый крем)
    ("hoodie",  0.500, 0.660, "#06b6d4"),  # худи (граница = резкое сужение силуэта)
    ("shorts",  0.660, 0.780, "#8b5cf6"),  # шорты
    ("sneaker", 0.780, 0.900, "#ffd60a"),  # кроссовки
    ("sole",    0.900, 1.001, "#e4e4e7"),  # подошва
]
SHADE_TOP, SHADE_BOTTOM = 1.04, 0.93      # лёгкое затемнение к низу каждой зоны (объём)
BOUNDARY_SHADE = 0.90                      # тень по стыку зон


def build_mask(img, bright=135, sat=70):
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    m = ((gray > bright) & (hsv[:, :, 1] < sat)).astype(np.uint8) * 255
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((11, 11), np.uint8), iterations=2)
    m = largest_component(m)
    m = strip_thin_lower(m)
    m = largest_component(cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((7, 7), np.uint8)))
    return ndimage.binary_fill_holes(m > 0).astype(np.uint8) * 255


def soft_alpha(mask):
    m = cv2.medianBlur(mask.copy(), 5)
    m = cv2.erode(m, np.ones((3, 3), np.uint8), iterations=2)
    return cv2.GaussianBlur(m, (5, 5), 0)


def mirror_ear(img, mask, axis, y_top, y_bottom, feather=10):
    """Правая половина головы = зеркало левой (восстанавливает закрытое рукой ухо)."""
    H, W = img.shape[:2]
    axis = int(round(axis))
    M = np.float32([[-1, 0, 2 * axis], [0, 1, 0]])
    mir_img = cv2.warpAffine(img, M, (W, H), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
    mir_mask = cv2.warpAffine(mask, M, (W, H), flags=cv2.INTER_NEAREST)

    alpha = np.zeros((H, W), np.float32)
    alpha[y_top:y_bottom, axis:] = 1.0
    for d in range(feather):                       # плавный стык у оси симметрии
        alpha[y_top:y_bottom, axis + d] = (d + 1) / feather
    alpha = cv2.GaussianBlur(alpha, (0, 0), 1.5)[..., None]

    out = (img.astype(np.float32) * (1 - alpha) + mir_img.astype(np.float32) * alpha).astype(np.uint8)
    band = np.zeros((H, W), np.uint8)
    band[y_top:y_bottom, :] = 255
    new_mask = np.where(alpha[..., 0] > 0.5, mir_mask, mask).astype(np.uint8)
    new_mask = cv2.bitwise_or(new_mask, cv2.bitwise_and(mask, cv2.bitwise_not(band)))
    new_mask = cv2.morphologyEx(new_mask, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
    new_mask = ndimage.binary_fill_holes(new_mask > 0).astype(np.uint8) * 255
    return out, new_mask


def hex_to_ab(h):
    h = h.lstrip("#")
    rgb = np.uint8([[[int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)]]])
    _L, a, b = cv2.cvtColor(rgb, cv2.COLOR_RGB2LAB)[0, 0]
    return float(a), float(b)


def paint(img, mask):
    rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    lab = cv2.cvtColor(rgb, cv2.COLOR_RGB2LAB).astype(np.float32)
    ys, xs = np.where(mask > 127)
    y0, y1 = ys.min(), ys.max() + 1
    Hf = y1 - y0

    for name, a, b, col in PALETTE:
        ya, yb = int(y0 + a * Hf), int(y0 + b * Hf)
        zone = np.zeros_like(mask)
        zone[ya:yb, :] = 255
        sel = cv2.bitwise_and(zone, mask) > 127
        if not sel.any():
            continue
        la, lb = hex_to_ab(col)
        lab[..., 1][sel] = la * 0.92 + lab[..., 1][sel] * 0.08
        lab[..., 2][sel] = lb * 0.92 + lab[..., 2][sel] * 0.08
        # объём: зона светлее сверху, темнее к нижнему краю (мягкий градиент, без «полки»)
        n = max(yb - ya, 1)
        dip = max(int(n * 0.12), 2)
        shade = np.concatenate([
            np.linspace(SHADE_TOP, 1.0, n - dip, dtype=np.float32),
            np.linspace(1.0, SHADE_BOTTOM, dip, dtype=np.float32),
        ])[:n]
        lab[ya:yb, :, 0] = lab[ya:yb, :, 0] * shade[:, None]

    out = cv2.cvtColor(np.clip(lab, 0, 255).astype(np.uint8), cv2.COLOR_LAB2RGB)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="src", required=True)
    ap.add_argument("--out", dest="dst", required=True)
    ap.add_argument("--axis", type=float, default=None, help="ось симметрии головы в px (по умолчанию — по маске)")
    ap.add_argument("--no-ear", action="store_true", help="не восстанавливать ухо зеркалом")
    ap.add_argument("--no-paint", action="store_true", help="только вырез (для фото раскрашенной фигурки)")
    ap.add_argument("--quality", type=int, default=88)
    args = ap.parse_args()

    img = imread_unicode(args.src)
    mask = build_mask(img)

    if not args.no_ear:
        ys, xs = np.where(mask > 127)
        axis = args.axis if args.axis else (xs.min() + xs.max()) / 2.0
        y_top = int(ys.min() - 6)
        y_bottom = int(ys.min() + 0.28 * (ys.max() - ys.min()))
        img, mask = mirror_ear(img, mask, axis, y_top, y_bottom)
        print(f"зеркало головы: ось x={axis:.0f}, полоса y {y_top}..{y_bottom}")

    mask = soft_alpha(mask)
    img = paint(img, mask) if not args.no_paint else img

    ys, xs = np.where(mask > 127)
    x0, y0, x1, y1 = xs.min(), ys.min(), xs.max() + 1, ys.max() + 1
    rgba = cv2.cvtColor(img[y0:y1, x0:x1], cv2.COLOR_RGB2BGRA)
    rgba[:, :, 3] = mask[y0:y1, x0:x1]

    os.makedirs(os.path.dirname(os.path.abspath(args.dst)), exist_ok=True)
    ok, buf = cv2.imencode(".webp", rgba, [int(cv2.IMWRITE_WEBP_QUALITY), args.quality])
    if not ok:
        raise SystemExit("не удалось закодировать webp")
    buf.tofile(args.dst)
    print(f"силуэт: {x1 - x0}x{y1 - y0}px | сохранено: {args.dst} ({os.path.getsize(args.dst) // 1024} КБ)")


if __name__ == "__main__":
    main()
