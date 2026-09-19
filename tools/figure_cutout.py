#!/usr/bin/env python3
"""
Вырезает фигурку с фотографии и сохраняет webp с прозрачным фоном для hero-секции.

Использование (из корня репозитория):
    python tools/figure_cutout.py --in "игрушка.jpg" --out images/figure-hero.webp

Как это работает:
  1. маска «ярко и не насыщенно» (белый пластик на тёмном фоне) -> gray > 135 и S < 70
  2. смыкание краёв, берём крупнейшую связную компоненту (это фигурка)
  3. в нижней половине срезаем тонкие выступы (обрывки фона/стола)
  4. заливаем дыры внутри силуэта, эрозия убирает светлую кайму, размытие даёт мягкий край
  5. кроп по силуэту + сохранение в webp с альфой

Если после покраски фигурки фото новое — просто запусти команду ещё раз:
разметку на сайте менять не нужно, имя файла то же.
"""
import argparse
import os
import sys

import cv2
import numpy as np
from scipy import ndimage

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tool_common import ensure_parent_dir


def imread_unicode(path):
    """OpenCV на Windows не читает кириллические пути — читаем через numpy."""
    data = np.fromfile(path, dtype=np.uint8)
    img = cv2.imdecode(data, cv2.IMREAD_COLOR)
    if img is None:
        raise SystemExit(f"Не удалось открыть изображение: {path}")
    return img


def largest_component(mask):
    n, labels, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
    if n <= 1:
        return mask
    biggest = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    return np.where(labels == biggest, 255, 0).astype(np.uint8)


def strip_thin_lower(mask, kernel=13):
    """Убирает тонкие выступы в нижней половине (обрывки стола/бумаги у подошвы)."""
    h = mask.shape[0]
    opened = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((kernel, kernel), np.uint8))
    thin = cv2.subtract(mask, opened)
    keep = np.zeros_like(mask)
    keep[int(h * 0.45):] = thin[int(h * 0.45):]        # тонкое внизу — мусор
    return cv2.subtract(mask, keep)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="src", required=True, help="исходное фото фигурки")
    ap.add_argument("--out", dest="dst", required=True, help="куда сохранить webp")
    ap.add_argument("--bright", type=int, default=135, help="порог яркости пластика (по умолчанию 135)")
    ap.add_argument("--sat", type=int, default=70, help="максимальная насыщенность пластика (по умолчанию 70)")
    ap.add_argument("--erode", type=int, default=2, help="эрозия в px: убирает светлую кайму (по умолчанию 2)")
    ap.add_argument("--quality", type=int, default=88)
    args = ap.parse_args()

    img = imread_unicode(args.src)
    h, w = img.shape[:2]
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    mask = ((gray > args.bright) & (hsv[:, :, 1] < args.sat)).astype(np.uint8) * 255
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((11, 11), np.uint8), iterations=2)
    mask = largest_component(mask)
    mask = strip_thin_lower(mask)
    mask = largest_component(cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((7, 7), np.uint8)))
    mask = ndimage.binary_fill_holes(mask > 0).astype(np.uint8) * 255
    mask = cv2.medianBlur(mask, 5)
    if args.erode:
        mask = cv2.erode(mask, np.ones((3, 3), np.uint8), iterations=args.erode)
    mask = cv2.GaussianBlur(mask, (5, 5), 0)

    ys, xs = np.where(mask > 127)
    if len(xs) == 0:
        raise SystemExit("Маска пустая — подбери --bright/--sat под новое фото")
    x0, y0, x1, y1 = xs.min(), ys.min(), xs.max() + 1, ys.max() + 1
    if (x1 - x0) < 40 or (y1 - y0) < 40:
        raise SystemExit("Силуэт слишком маленький — скорее всего маска захватила не то")

    rgba = cv2.cvtColor(img[y0:y1, x0:x1], cv2.COLOR_BGR2BGRA)
    rgba[:, :, 3] = mask[y0:y1, x0:x1]

    ensure_parent_dir(args.dst)
    ok, buf = cv2.imencode(".webp", rgba, [int(cv2.IMWRITE_WEBP_QUALITY), args.quality])
    if not ok:
        raise SystemExit("Не удалось закодировать webp")
    buf.tofile(args.dst)

    ratio = (x1 - x0) / (y1 - y0)
    print(f"фото: {w}x{h}")
    print(f"силуэт: {x1 - x0}x{y1 - y0}px, соотношение ширина/высота {ratio:.3f}")
    print(f"сохранено: {args.dst} ({os.path.getsize(args.dst) // 1024} КБ)")
    print(f"подсказка: при высоте 478px на сайте ширина будет ≈ {round(478 * ratio)}px "
          f"(ассет снят с фото, картинка мягче при увеличении >1.25x)")


if __name__ == "__main__":
    main()
