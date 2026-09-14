#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Числовая проверка ассета фигурки для hero. Проверять глазами бесполезно:
vision на одном и том же кропе говорит то «ухо — часть кепки», то «ухо своё».
Здесь — только измерения, с вердиктом OK/ПЛОХО по каждому пункту.

Что проверяет:
  1. альфа: мин/макс, доля полупрозрачных (кромка), прозрачность углов кадра;
  2. силуэт не касается краёв кадра;
  3. аспект (ширина/высота) — из него считается --fig-w в styles/main.css;
  4. НОГИ: в нижней трети кадра силуэт в строке должен распадаться на ДВЕ группы
     (две ноги). Одна группа = у фигурки пропала нога (баг klein «уходит в шаг»).

Пример:
  python tools/figure_check.py --in images/figure-hero.webp
  python tools/figure_check.py --in tmp/cand.png --fig-h 478 --strict-legs
"""
import argparse
import os

import cv2
import numpy as np


def read_img(path):
    buf = np.fromfile(path, dtype=np.uint8)
    img = cv2.imdecode(buf, cv2.IMREAD_UNCHANGED)
    if img is None:
        raise SystemExit(f"не удалось прочитать: {path}")
    return img


def row_groups(mask_row, min_gap, min_len):
    """Группы пикселей в строке; разрывы уже min_gap сливаются (шнуровка, блик)."""
    idx = np.where(mask_row)[0]
    if idx.size == 0:
        return []
    groups, start, prev = [], idx[0], idx[0]
    for x in idx[1:]:
        if x - prev - 1 >= min_gap:          # разрыв шире допуска — новая группа
            groups.append((int(start), int(prev), int(prev - start + 1)))
            start = x
        prev = x
    groups.append((int(start), int(prev), int(prev - start + 1)))
    return [g for g in groups if g[2] >= min_len]


def main():
    ap = argparse.ArgumentParser(description="Числовая проверка ассета фигурки")
    ap.add_argument("--in", dest="src", required=True)
    ap.add_argument("--fig-h", type=float, default=478.0, help="высота фигурки на сайте, px (для --fig-w)")
    ap.add_argument("--alpha-thr", type=int, default=127, help="порог силуэта по альфе")
    ap.add_argument("--min-gap", type=int, default=6, help="разрыв в строке, разделяющий ноги, px")
    ap.add_argument("--min-len", type=int, default=4, help="минимальная ширина группы, px")
    args = ap.parse_args()

    img = read_img(args.src)
    if img.ndim != 3 or img.shape[2] != 4:
        raise SystemExit(f"нужен webp/png с альфой, получено shape={img.shape}")

    rgb, al = img[:, :, :3], img[:, :, 3]
    h, w = al.shape
    mask = al > args.alpha_thr
    bad = []

    print(f"файл: {args.src}  {w}x{h}  {os.path.getsize(args.src) // 1024} КБ")
    print(f"аспект: {w / h:.4f}   --fig-w при высоте {args.fig_h:.0f}px = {args.fig_h * w / h:.1f}px")

    # 1. альфа
    semi = float(((al > 0) & (al < 255)).mean() * 100)
    corners = [int(al[0, 0]), int(al[0, -1]), int(al[-1, 0]), int(al[-1, -1])]
    print(f"альфа: min={al.min()} max={al.max()} полупрозрачных={semi:.2f}%  углы={corners}")
    if al.min() != 0 or al.max() != 255:
        bad.append("альфа не покрывает 0…255 — останется вуаль")
    if max(corners) != 0:
        bad.append(f"угол кадра не прозрачен ({max(corners)})")
    if not (1.0 <= semi <= 8.0):
        bad.append(f"полупрозрачных {semi:.2f}% (норма 1–8%: только кромка)")

    # 2. поля кадра
    ys, xs = np.where(mask)
    if ys.size == 0:
        raise SystemExit("силуэт пуст")
    top, bot, left, right = int(ys.min()), int(ys.max()), int(xs.min()), int(xs.max())
    touch = []
    if top <= 1:
        touch.append("верх")
    if bot >= h - 2:
        touch.append("низ")
    if left <= 1:
        touch.append("левый край")
    if right >= w - 2:
        touch.append("правый край")
    # готовый ассет обрезан по bbox (figure_from_ai.py, pad=0) — тогда касание краёв норма,
    # а вот на сырой генерации это значит, что AI обрезал фигурку рамкой кадра
    tight = (bot - top + 1) >= h - 2 and (right - left + 1) >= w - 2
    print(f"силуэт bbox: x {left}…{right}, y {top}…{bot}  (поля: верх {top}, низ {h - 1 - bot}, "
          f"лево {left}, право {w - 1 - right})")
    if touch and tight:
        print("  (поля нулевые — это обрезка по bbox, так и задумано; отсечения фигурки тут не увидеть)")
    elif touch:
        bad.append("фигурка упирается в край кадра: " + ", ".join(touch))

    # 3. ноги в нижней трети силуэта
    fig_h = bot - top + 1
    print("--- НОГИ: группы силуэта в строке, нижняя треть ---")
    leg_zone, shoe_zone = [], []
    for frac in (0.60, 0.65, 0.70, 0.75, 0.80, 0.85, 0.90, 0.95, 0.99):
        y = min(h - 1, top + int(fig_h * frac))
        groups = row_groups(mask[y], args.min_gap, args.min_len)
        width = right - left + 1
        print(f"  y={y:4d} ({frac:.2f}) групп={len(groups)}: {groups}"
              + ("   ← силуэт слит во всю ширину" if len(groups) == 1 and groups[0][2] > 0.75 * width else ""))
        (leg_zone if frac < 0.85 else shoe_zone).append((frac, len(groups)))
    two_leg = [f for f, n in leg_zone if n == 2]
    two_shoe = [f for f, n in shoe_zone if n == 2]
    print(f"две группы: в зоне ног {two_leg or '—'}; в зоне кроссовок {two_shoe or '—'}")
    # одна нога = силуэт слит в один столбец по всей нижней трети. Соприкосновение кроссовок
    # (две группы выше, одна в самой нижней строке) — это нормально, а не пропавшая нога.
    if not two_shoe:
        bad.append("в зоне кроссовок ни в одной строке нет двух групп — второй ноги нет")
    elif not two_leg:
        print("  (предупреждение: ноги разделяются только у кроссовок — длинное худи скрывает бёдра)")

    print()
    if bad:
        print("ВЕРДИКТ: ПЛОХО")
        for b in bad:
            print("  !", b)
        raise SystemExit(1)
    print("ВЕРДИКТ: OK — альфа, поля, аспект и две ноги в норме")


if __name__ == "__main__":
    main()
