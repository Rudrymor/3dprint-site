# -*- coding: utf-8 -*-
"""Числовая проверка кромки (кайма/ореол) + карточка «было → стало» для владельца.

Запуск: python tools/edge_report.py
"""
import os
import shutil

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REVIEW = r"C:\Users\metal\web-sites\_review-3dprint"
SITE_BG = (9, 9, 11)


def read(path):
    return cv2.imdecode(np.fromfile(path, dtype=np.uint8), cv2.IMREAD_UNCHANGED)


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
    for name, rel in [("было (s2, 291x593)", "tmp/old-asset-s2.webp"),
                      ("стало (C, 289x593)", "images/figure-hero.webp"),
                      ("битый V1, ушёл с сайта", "tmp/old-asset-v1.webp")]:
        d, b, i = fringe_metric(os.path.join(REPO, rel))
        print("%-26s яркость кромки − тело = %+.2f  (кромка %.0f, тело %.0f)" % (name, d, b, i))

    h = 520
    old = compose(os.path.join(REPO, "tmp/old-asset-s2.webp"), h)
    new = compose(os.path.join(REPO, "images/figure-hero.webp"), h)
    light = compose(os.path.join(REPO, "images/figure-hero.webp"), h, bg=(245, 245, 245))
    pad, top = 24, 34
    w = old.size[0] + new.size[0] + light.size[0] + pad * 4
    canvas = Image.new("RGB", (w, h + top + pad), (24, 24, 27))
    draw = ImageDraw.Draw(canvas)
    try:
        font = ImageFont.load_default(size=17)
    except TypeError:
        font = ImageFont.load_default()
    x = pad
    for im, label in [(old, "БЫЛО: s2 (без референса)"),
                      (new, "СТАЛО: вариант C (на сайте)"),
                      (light, "C на светлом фоне — проверка каймы")]:
        canvas.paste(im, (x, top))
        draw.text((x, 8), label, font=font, fill=(240, 240, 245))
        x += im.size[0] + pad
    os.makedirs(REVIEW, exist_ok=True)
    card = os.path.join(REVIEW, "C-before-after-and-halo.png")
    canvas.save(card)
    shutil.copy(os.path.join(REPO, "images/figure-hero.webp"),
                os.path.join(REVIEW, "asset-C-289x593.webp"))
    print("карточка:", card, canvas.size)
    print("ассет C скопирован в", REVIEW)


if __name__ == "__main__":
    main()
