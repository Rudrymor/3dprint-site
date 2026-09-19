# -*- coding: utf-8 -*-
"""Числовая проверка кромки (кайма/ореол) + карточка «было → стало» для владельца.

Примеры:
  python tools/edge_report.py
  python tools/edge_report.py --old tmp/old-asset-s2.webp --new images/figure-hero.webp
  python tools/edge_report.py --new images/figure-hero.webp --review-dir "%LOCALAPPDATA%/Temp/figwork"

Ассеты «было» лежат в tmp/ и в git не попадают (tmp/ исключён из репозитория): после
чистого клона их просто нет. Скрипт об этом честно скажет и покажет то, что нашёл.
"""
import argparse
import os
import shutil
import sys

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tool_common import ensure_parent_dir, int_range

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:                      # понятное сообщение вместо трейсбека
    raise SystemExit("нужен Pillow: pip install pillow")

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE_BG = (9, 9, 11)
LIGHT_BG = (245, 245, 245)


def read(path):
    """Читает png/webp с альфой; о проблеме сообщает понятной строкой."""
    if not os.path.exists(path):
        raise SystemExit(f"файл не найден: {path}")
    img = cv2.imdecode(np.fromfile(path, dtype=np.uint8), cv2.IMREAD_UNCHANGED)
    if img is None:
        raise SystemExit(f"не удалось прочитать: {path}")
    if img.ndim != 3 or img.shape[2] != 4:
        raise SystemExit(f"нужен png/webp с альфой, получено shape={img.shape}: {path}")
    return img


def fringe_metric(path):
    """Яркость полосы кромки минус яркость тела. > ~5 = светлый ореол от старого фона."""
    img = read(path)
    rgb = cv2.cvtColor(img[:, :, :3], cv2.COLOR_BGR2RGB).astype(np.float32)
    al = img[:, :, 3]
    m = (al > 127).astype(np.uint8)
    k = np.ones((3, 3), np.uint8)
    inner = cv2.erode(m, k, iterations=6).astype(bool)
    band = cv2.dilate(m, k, iterations=2).astype(bool)
    band = np.logical_and(band, np.logical_not(cv2.erode(m, k, iterations=2).astype(bool)))
    lum = 0.2126 * rgb[:, :, 0] + 0.7152 * rgb[:, :, 1] + 0.0722 * rgb[:, :, 2]
    return float(lum[band].mean() - lum[inner].mean()), float(lum[band].mean()), float(lum[inner].mean())


def compose(path, h, bg=SITE_BG):
    im = Image.open(path).convert("RGBA")
    w = max(1, round(im.size[0] * h / im.size[1]))
    a = np.asarray(im.resize((w, h), Image.LANCZOS)).astype(np.float32)
    al = a[:, :, 3:4] / 255.0
    return Image.fromarray((a[:, :, :3] * al + np.array(bg, dtype=np.float32) * (1 - al)).astype(np.uint8))


def main():
    ap = argparse.ArgumentParser(description="Проверка кромки ассетов + карточка «было → стало»")
    ap.add_argument("--old", default=os.path.join(REPO, "tmp", "old-asset-s2.webp"),
                    help="ассет «было» (по умолчанию tmp/old-asset-s2.webp)")
    ap.add_argument("--new", default=os.path.join(REPO, "images", "figure-hero.webp"),
                    help="ассет «стало», он же текущий на сайте (по умолчанию images/figure-hero.webp)")
    ap.add_argument("--broken", default=os.path.join(REPO, "tmp", "old-asset-v1.webp"),
                    help="третий ассет для сравнения, необязательный (по умолчанию tmp/old-asset-v1.webp)")
    ap.add_argument("--review-dir", default=os.path.join(os.path.dirname(REPO), "_review"),
                    help="куда положить карточку (по умолчанию — папка _review рядом с репозиторием)")
    ap.add_argument("--height", type=int_range(64, 2000, "--height"), default=520,
                    help="высота превью в карточке, px")
    args = ap.parse_args()

    if not os.path.exists(args.new):
        raise SystemExit(f"основной ассет не найден: {args.new}\n  положи файл на место или укажи --new ПУТЬ")

    print("ЯРКОСТЬ КРОМКИ (кромка минус тело; больше ~5 — светлый ореол от старого фона):")
    for title, path in (("стало", args.new), ("было (s2)", args.old), ("битый V1", args.broken)):
        if not os.path.exists(path):
            print(f"  {title:<12} пропущено: файла нет ({path})")
            continue
        diff, band, body = fringe_metric(path)
        print(f"  {title:<12} {diff:+6.2f}  (кромка {band:.0f}, тело {body:.0f})  {os.path.basename(path)}")

    h = args.height
    tiles = []
    if os.path.exists(args.old):
        tiles.append(("БЫЛО: s2 (без референса)", compose(args.old, h)))
    tiles.append(("СТАЛО: текущий ассет (на сайте)", compose(args.new, h)))
    tiles.append(("то же на светлом фоне — проверка каймы", compose(args.new, h, bg=LIGHT_BG)))

    pad, top = 24, 34
    w = sum(t.size[0] for _, t in tiles) + pad * (len(tiles) + 1)
    canvas = Image.new("RGB", (w, h + top + pad), (24, 24, 27))
    draw = ImageDraw.Draw(canvas)
    try:
        font = ImageFont.load_default(size=17)
    except TypeError:                    # старый Pillow: размер у шрифта не задаётся
        font = ImageFont.load_default()
    x = pad
    for label, im in tiles:
        canvas.paste(im, (x, top))
        draw.text((x, 8), label, font=font, fill=(240, 240, 245))
        x += im.size[0] + pad

    card = os.path.join(args.review_dir, "C-before-after-and-halo.png")
    ensure_parent_dir(card)
    canvas.save(card)
    print(f"карточка: {card} {canvas.size}")

    asset_copy = os.path.join(args.review_dir, os.path.basename(args.new))
    shutil.copy(args.new, asset_copy)
    print(f"ассет скопирован в {asset_copy}")


if __name__ == "__main__":
    main()
