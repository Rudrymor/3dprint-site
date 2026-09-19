#!/usr/bin/env python3
"""
figure_hero.py — готовит ассет фигурки для hero-секции главной страницы.

Пайплайн:
  1. вырез фигурки с фото (маска «ярко и не насыщенно»);
  2. симметрия головы: правое ухо на фото закрыто рукой — обрезанный силуэт добирается
     зеркалом левой половины вокруг оси фигуры (настоящие пиксели остаются на месте);
  3. покраска по ЭЛЕМЕНТАМ: каждая граница (низ кепки, ворот, манжеты, верх кроссовок,
     стык подошвы, стык уха и кепки) ищется как путь минимальной стоимости по карте
     рёбер в узком коридоре вокруг прикидки — поэтому шов ложится на реальный рельеф,
     а не на горизонтальную полосу;
  4. на кепку наносится чёрная надпись ICON: родной рельеф букв выравнивается, буквы
     темнятся умножением, поэтому сидят в светотени кепки, а не выглядят наклейкой.

Использование (из корня репозитория):
    python tools/figure_hero.py --in "игрушка.jpg" --out images/figure-hero.webp
    python tools/figure_hero.py --in "фото.jpg" --out images/figure-hero.webp --no-paint
    python tools/figure_hero.py --in "игрушка.jpg" --debug-dir "%LOCALAPPDATA%/Temp/figwork"

Цвета — в PALETTE (правь hex и перезапускай).
"""
import argparse
import os
import sys

import cv2
import numpy as np
from scipy import ndimage

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from figure_cutout import imread_unicode, largest_component, strip_thin_lower
from tool_common import ensure_parent_dir, int_range

# ───────────────────────────── параметры ─────────────────────────────
PALETTE = {
    "cap":    "#f3f3f5",   # кепка (белая)
    "fur":    "#d97316",   # шерсть: морда, уши, лапы (рыжая)
    "hoodie": "#2f6bff",   # худи и подол (синие)
    "shoe":   "#7c3aed",   # кроссовки (фиолетовые)
    "sole":   "#a08af7",   # подошва (светлее верха)
}
INK = "#0e0e12"            # цвет надписи ICON
ICON_TEXT = "ICON"
SHADE_GAMMA = 0.92         # перенос рельефа: <1 — контраст мягче

# границы: имя -> (доля высоты, полувысота коридора в долях высоты)
SEAMS = {
    "brim":   (0.348,  0.009),   # низ козырька кепки (вместе с тенью под ним)
    "collar": (0.455,  0.018),   # ворот худи (низ морды)
    "cuff":   (0.605,  0.020),   # манжеты рукавов
    "shoe":   (0.729,  0.012),   # верх кроссовок
    "sole":   (0.882,  0.004),   # стык подошвы
}
PAW_X = 0.24                   # шире этой доли от края — уже лапа, а не рукав
PAW_DEPTH = 0.070              # насколько лапа может уходить ниже манжеты (доля высоты)
# стык уха и кепки: x(y) = EAR_X0 - EAR_SLOPE*y для левой половины
EAR_X0, EAR_SLOPE, EAR_HALF = 92.0, 0.78, 16.0
EAR_YMAX = 0.20                # ниже этой доли высоты стык уха не ищем


# ───────────────────────────── маска/вырез ─────────────────────────────
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
    """Мягкая кромка минимальной ширины: сильно эродировать нельзя — низ фигурки
    (подошвы) уходил в полупрозрачность и выглядел размытым."""
    m = cv2.medianBlur(mask.copy(), 3)
    m = cv2.erode(m, np.ones((2, 2), np.uint8), iterations=1)
    return cv2.GaussianBlur(m, (3, 3), 0.7)


def darken_rim(rgb, mask, width=2, k=0.86):
    """Тёмная кромка по силуэту: убирает светлый ореол, который остаётся от фото."""
    inside = (mask > 127).astype(np.uint8)
    er = cv2.erode(inside, np.ones((3, 3), np.uint8), iterations=width)
    rim = (inside > 0) & (er == 0)
    if not rim.any():
        return rgb
    w = cv2.GaussianBlur(rim.astype(np.float32), (0, 0), 0.8)[..., None]
    w = np.clip(w * 1.6, 0, 1)
    out = rgb.astype(np.float32) * (1 - w) + rgb.astype(np.float32) * k * w
    return np.clip(out, 0, 255).astype(np.uint8)


# ───────────────────────────── голова: симметрия ─────────────────────────────
def find_axis(mask, ya, yb):
    """Ось симметрии = медиана центров силуэта там, где силуэт не обрезан рукой."""
    m = mask > 127
    centers = []
    for y in range(int(ya), int(yb)):
        xs = np.where(m[y])[0]
        if len(xs) > 12:
            centers.append((xs.min() + xs.max()) / 2.0)
    return int(round(float(np.median(centers)))) if centers else m.shape[1] // 2


def fix_head(img, mask, axis, y_bottom, feather=4.0):
    H, W = img.shape[:2]
    M = np.float32([[-1, 0, 2 * axis], [0, 1, 0]])
    mi = cv2.warpAffine(img, M, (W, H), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
    mm = cv2.warpAffine(mask, M, (W, H), flags=cv2.INTER_NEAREST)
    patch = (mm > 127) & (mask <= 127)
    band = np.zeros((H, W), bool)
    band[:y_bottom] = True
    right = np.zeros((H, W), bool)
    right[:, axis:] = True
    patch &= band & right
    patch = cv2.morphologyEx(patch.astype(np.uint8) * 255, cv2.MORPH_CLOSE,
                             np.ones((13, 13), np.uint8)) > 127
    patch &= band & right
    if patch.sum() < 10:
        return img, mask, patch
    alpha = np.clip(cv2.GaussianBlur(patch.astype(np.float32), (0, 0), feather) * 2.2, 0, 1)[..., None]
    real = (mask > 127) & band & ~patch
    if real.any():
        gain = float(np.median(img[real][:, 1])) / max(float(np.median(img[patch][:, 1])), 1e-3)
        gain = float(np.clip(gain, 0.85, 1.15))
        mi = np.clip(mi.astype(np.float32) * gain, 0, 255).astype(np.uint8)
    out = (img.astype(np.float32) * (1 - alpha) + mi.astype(np.float32) * alpha).astype(np.uint8)
    new_mask = np.maximum(mask, (mm * (alpha[..., 0] > 0.5))).astype(np.uint8)
    new_mask = ndimage.binary_fill_holes(new_mask > 127).astype(np.uint8) * 255
    return out, cv2.morphologyEx(new_mask, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8)), patch


# ───────────────────────────── рёбра и швы ─────────────────────────────
def edge_map(img):
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    g = cv2.createCLAHE(2.5, (8, 8)).apply(g).astype(np.float32)
    gy = cv2.Sobel(g, cv2.CV_32F, 0, 1, ksize=3)
    gx = cv2.Sobel(g, cv2.CV_32F, 1, 0, ksize=3)
    e = cv2.GaussianBlur(np.sqrt(gx ** 2 + gy ** 2), (0, 0), 1.6)
    return (np.clip(e, 0, 120) / 120.0).astype(np.float32)


def hpath(E, inside, y_guess, half, xa=0, xb=None, smooth=1.1):
    """Горизонтальный шов: для каждого x выбирается y по минимуму -рельеф + изгиб."""
    H, W = E.shape
    xb = W if xb is None else xb
    ylo, yhi = max(int(y_guess - half), 1), min(int(y_guess + half) + 1, H - 1)
    n = xb - xa
    c = -E[ylo:yhi, xa:xb]
    c = np.where(inside[ylo:yhi, xa:xb], c, 10.0)
    dp = np.full((yhi - ylo, n), 1e9, np.float32)
    bk = np.zeros((yhi - ylo, n), np.int8)
    dp[:, 0] = c[:, 0]
    for i in range(1, n):
        for k in range(yhi - ylo):
            best, bo = dp[k, i - 1], 0
            for d in (-2, -1, 1, 2):
                kk = k + d
                if 0 <= kk < yhi - ylo:
                    v = dp[kk, i - 1] + smooth * abs(d)
                    if v < best:
                        best, bo = v, d
            dp[k, i] = best + c[k, i]
            bk[k, i] = bo
    k = int(np.argmin(dp[:, n - 1]))
    ys = np.zeros(n, np.int32)
    ys[n - 1] = k
    for i in range(n - 1, 0, -1):
        k += int(bk[k, i])
        ys[i - 1] = k
    out = np.full(W, -1, np.int32)
    out[xa:xb] = ys + ylo
    return out


def vpath(E, inside, x_guess, half, ya, yb, smooth=1.1):
    """Вертикальный шов (для стыка уха и кепки): для каждого y выбирается x."""
    H, W = E.shape
    xlo = max(int(np.min(x_guess) - half), 1)
    xhi = min(int(np.max(x_guess) + half) + 1, W - 1)
    n = yb - ya
    c = np.zeros((n, xhi - xlo), np.float32)
    for i, y in enumerate(range(ya, yb)):
        c[i] = np.where(inside[y, xlo:xhi], -E[y, xlo:xhi], 10.0)
    # тянем к прикидке там, где рельефа нет
    gx = np.clip(x_guess[ya:yb] - xlo, 0, xhi - xlo - 1)
    pen = np.abs(np.arange(xhi - xlo)[None, :] - gx[:, None]).astype(np.float32) * 0.02
    c = c + pen
    dp = np.full((n, xhi - xlo), 1e9, np.float32)
    bk = np.zeros((n, xhi - xlo), np.int8)
    dp[0] = c[0]
    for i in range(1, n):
        for k in range(xhi - xlo):
            best, bo = dp[i - 1, k], 0
            for d in (-2, -1, 1, 2):
                kk = k + d
                if 0 <= kk < xhi - xlo:
                    v = dp[i - 1, kk] + smooth * abs(d)
                    if v < best:
                        best, bo = v, d
            dp[i, k] = best + c[i, k]
            bk[i, k] = bo
    k = int(np.argmin(dp[n - 1]))
    out = np.zeros(n, np.int32)
    out[n - 1] = k
    for i in range(n - 1, 0, -1):
        k += int(bk[i, k])
        out[i - 1] = k
    return out + xlo


# ───────────────────────────── покраска ─────────────────────────────
def hex_to_lab(h):
    h = h.lstrip("#")
    rgb = np.uint8([[[int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)]]])
    return cv2.cvtColor(rgb, cv2.COLOR_RGB2LAB)[0, 0].astype(np.float32)


def recolor(lab, sel, hexcol, gamma=SHADE_GAMMA):
    if not sel.any():
        return
    lt, at, bt = hex_to_lab(hexcol)
    l = lab[..., 0]
    vals = l[sel]
    ref = float(np.median(vals)) if vals.size else 220.0
    new = np.clip(lt * np.power(np.clip(vals / max(ref, 1e-3), 0.05, 3.0), gamma), 0, 255)
    l[sel] = new
    # в глубокой тени хрома падает — иначе тёмные участки уезжают в чистую синеву
    k = np.clip((new / max(lt, 1e-3)) ** 0.45, 0.5, 1.0)
    lab[..., 1][sel] = np.clip(128 + (at - 128) * k, 0, 255)
    lab[..., 2][sel] = np.clip(128 + (bt - 128) * k, 0, 255)


def cap_icon_box(cap_sel, brim_y):
    """Передняя панель кепки: рамка для надписи считается по самой зоне кепки."""
    rows = np.where(cap_sel.any(axis=1))[0]
    if len(rows) < 20:
        return None
    band = slice(int(brim_y * 0.35), int(brim_y * 0.95))
    sub = cap_sel[band]
    cols = np.where(sub.any(axis=0))[0]
    if len(cols) < 20:
        return None
    x0, x1 = int(cols.min()), int(cols.max())
    cx = (x0 + x1) / 2
    w = (x1 - x0) * 0.62            # ширина полосы выравнивания рельефа
    h = band.stop - band.start
    return (int(cx - w / 2), band.start, int(cx + w / 2), band.stop)


def draw_icon(rgb, box, text=ICON_TEXT, ink=INK, width_frac=0.74, arc=0.12):
    """Надпись на передней панели: родной рельеф выравнивается, буквы темнятся умножением."""
    from PIL import Image, ImageDraw, ImageFont
    x0, y0, x1, y1 = box
    H, W = rgb.shape[:2]
    x0, x1 = max(x0, 0), min(x1, W)
    y0, y1 = max(y0, 0), min(y1, H)
    w, h = x1 - x0, y1 - y0
    if w < 40 or h < 20:
        return rgb
    # 1. выравниваем высокочастотный рельеф (родные буквы и швы панели), светотень остаётся
    sub = rgb[y0:y1, x0:x1]
    lab = cv2.cvtColor(sub, cv2.COLOR_RGB2LAB)
    l = lab[..., 0].astype(np.float32)
    med = cv2.medianBlur(l.astype(np.uint8), 9).astype(np.float32)
    smooth = cv2.GaussianBlur(med, (0, 0), max(h * 0.16, 5))
    l = smooth + np.clip(med - smooth, -1.2, 1.2)
    lab[..., 0] = np.clip(l, 0, 255).astype(np.uint8)
    rgb[y0:y1, x0:x1] = cv2.cvtColor(lab, cv2.COLOR_LAB2RGB)
    # 2. буквы: размер по ширине панели
    fp = None
    for cand in ("DejaVuSans-Bold.ttf", "arialbd.ttf", "Arial Bold.ttf", "DejaVuSans.ttf"):
        try:
            fp = ImageFont.truetype(cand, 40)
            break
        except OSError:
            continue
    if fp is None:
        return rgb
    ss = 4
    target = w * width_frac * ss
    size, t = 40, None
    for _ in range(60):
        canvas = Image.new("L", (int(w * ss), int(h * ss)), 0)
        dr = ImageDraw.Draw(canvas)
        font = ImageFont.truetype(fp.path, max(size, 8))
        bb = dr.textbbox((0, 0), text, font=font)
        tw = bb[2] - bb[0]
        if tw >= target or size <= 10:
            t = np.array(canvas).astype(np.float32)
            break
        size = int(size * 1.06)
    if t is None:
        return rgb
    # финальная отрисовка с центрированием
    canvas = Image.new("L", (int(w * ss), int(h * ss)), 0)
    dr = ImageDraw.Draw(canvas)
    bb = dr.textbbox((0, 0), text, font=font)
    dr.text(((w * ss - (bb[2] - bb[0])) / 2 - bb[0], (h * ss - (bb[3] - bb[1])) / 2 - bb[1]),
            text, font=font, fill=255)
    t = np.array(canvas).astype(np.float32) / 255.0
    if arc:                                   # буквы повторяют кривизну панели
        tw = int(w * ss)
        norm = (np.arange(tw) - tw / 2) / (tw / 2)
        for i in range(tw):
            t[:, i] = np.roll(t[:, i], int(arc * h * ss / 2 * norm[i] ** 2))
    t = cv2.resize(t, (w, h), interpolation=cv2.INTER_AREA)
    t = cv2.GaussianBlur(t, (0, 0), 0.7)
    ink_rgb = np.array([int(ink[1:3], 16), int(ink[3:5], 16), int(ink[5:7], 16)], np.float32)
    base = rgb[y0:y1, x0:x1].astype(np.float32)
    dark = np.clip(base * (ink_rgb / 255.0) ** 0.85 * 1.6, 0, 255)
    out = base * (1 - t[..., None]) + dark * t[..., None]
    # лёгкий рельеф: снизу от букв светлая кромка, сверху — тень (как у литых букв)
    rim_hi = np.clip(np.roll(t, 1, axis=0) - t, 0, 1)[..., None]
    rim_lo = np.clip(np.roll(t, -1, axis=0) - t, 0, 1)[..., None]
    out = out + rim_hi * base * 0.16
    out = out * (1 - rim_lo * 0.10)
    rgb[y0:y1, x0:x1] = np.clip(out, 0, 255).astype(np.uint8)
    return rgb, t


# ───────────────────────────── основной пайплайн ─────────────────────────────
def process(src, dst=None, axis=None, do_head=True, do_paint=True, quality=88, debug_dir=None):
    img0 = imread_unicode(src)
    mask0 = build_mask(img0)
    ys, xs = np.where(mask0 > 127)
    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    img = img0[y0:y1, x0:x1].copy()
    mask = mask0[y0:y1, x0:x1].copy()
    H, W = mask.shape
    if axis is not None and not (0 <= axis < W):
        raise SystemExit(
            f"--axis {axis} за пределами фигурки (ширина {W}px, допустимо 0..{W - 1}).\n"
            f"  ось считается по обрезанному силуэту; без --axis она подбирается автоматически."
        )
    inside = mask > 127
    print(f"фигурка {W}x{H}")

    if do_head:
        ax = axis if axis is not None else find_axis(mask, 0.34 * H, 0.72 * H)
        img, mask, patch = fix_head(img, mask, ax, int(0.34 * H))
        inside = mask > 127
        print(f"ось симметрии x={ax}, заплатка {int(patch.sum())} px")

    if do_paint:
        E = edge_map(img)
        yy = np.arange(H)[:, None] * np.ones((1, W), np.int32)
        xx = np.ones((H, 1), np.int32) * np.arange(W)[None, :]

        f = {}
        for name, (fy, half) in SEAMS.items():
            p = hpath(E, inside, fy * H, half * H)
            f[name] = np.where(p > 0, p, int(fy * H)).astype(np.int32)
            v = f[name][p > 0]
            print(f"  шов {name}: y≈{int(np.median(v))} ({np.median(v)/H*100:.1f}%), "
                  f"разброс {v.max()-v.min()}px")

        # стык уха и кепки: слева x(y), справа — зеркало
        ax = axis if axis is not None else find_axis(mask, 0.34 * H, 0.72 * H)
        ym = int(EAR_YMAX * H)
        guess = EAR_X0 - EAR_SLOPE * np.arange(H)
        ear_l = vpath(E, inside, guess, EAR_HALF, 0, ym)
        full_l = np.zeros(H, np.int32)
        full_l[:ym] = ear_l
        full_l[ym:] = -1
        full_r = np.where(full_l >= 0, 2 * ax - full_l, -1)
        print(f"  стык уха: слева x {full_l[:ym].min()}..{full_l[:ym].max()}")

        brim, collar, cuff, shoe, sole = (f["brim"][None, :], f["collar"][None, :],
                                          f["cuff"][None, :], f["shoe"][None, :], f["sole"][None, :])
        xl = full_l[:, None]                       # x стыка уха по строкам
        xr = np.where(full_r >= 0, full_r, 10 ** 6)[:, None]
        hasl = (full_l[:, None] >= 0)
        hasr = (full_r[:, None] >= 0)
        ear_l_sel = hasl & (xx <= xl)
        ear_r_sel = hasr & (xx >= xr)
        reg = {}
        reg["cap"] = (yy <= brim) & inside & ~(ear_l_sel | ear_r_sel)
        reg["fur"] = (((yy > brim) & (yy <= collar) & inside)
                      | (ear_l_sel & (yy <= brim)) | (ear_r_sel & (yy <= brim)))
        reg["hoodie"] = (yy > collar) & (yy <= shoe) & inside
        reg["shoe"] = (yy > shoe) & (yy <= sole) & inside
        reg["sole"] = (yy > sole) & inside
        # лапы: низ рукавов по бокам — шерсть
        paw = ((yy > cuff) & (yy <= cuff + PAW_DEPTH * H) & reg["hoodie"]
               & ((xx < PAW_X * W) | (xx > (1 - PAW_X) * W)))
        reg["hoodie"] = reg["hoodie"] & ~paw
        reg["fur"] = reg["fur"] | paw

        lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB).astype(np.float32)
        # индексная карта зон + медианный фильтр: границы без пиксельных ступенек
        order = ["cap", "fur", "hoodie", "shoe", "sole"]
        idx = np.zeros((H, W), np.uint8)
        for i, key in enumerate(order, start=1):
            idx[reg[key] & inside] = i
        idx = cv2.medianBlur(idx, 3)
        for i, key in enumerate(order, start=1):
            sel = (idx == i)
            g = 0.78 if key in ("cap", "sole") else SHADE_GAMMA
            recolor(lab, sel, PALETTE[key], gamma=g)
            print(f"  {key}: {sel.sum()/max(inside.sum(),1)*100:.1f}%")
        rgb = cv2.cvtColor(np.clip(lab, 0, 255).astype(np.uint8), cv2.COLOR_LAB2RGB)

        box = cap_icon_box(idx == 1, float(np.median(f["brim"][f["brim"] > 0])))
        if box:
            print(f"  панель для надписи: x {box[0]}..{box[2]}, y {box[1]}..{box[3]}")
            rgb, t = draw_icon(rgb, box)
    else:
        rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)

    if debug_dir:
        ensure_parent_dir(os.path.join(debug_dir, "paint_preview.png"))
        dark = np.zeros_like(rgb)
        dark[:] = (11, 9, 9)
        al = mask[..., None].astype(np.float32) / 255.0
        comp = (rgb.astype(np.float32) * al + dark * (1 - al)).astype(np.uint8)
        cv2.imwrite(os.path.join(debug_dir, "paint_preview.png"),
                    cv2.resize(comp, None, fx=2.6, fy=2.6, interpolation=cv2.INTER_CUBIC))
        if do_paint:
            vis = img.copy()
            for nm, col in (("brim", (0, 0, 255)), ("collar", (0, 255, 0)), ("cuff", (255, 255, 0)),
                            ("shoe", (255, 0, 255)), ("sole", (0, 255, 255))):
                for x in range(W):
                    cv2.circle(vis, (x, int(f[nm][x])), 1, col, -1)
            for y in range(ym):
                if full_l[y] > 0:
                    cv2.circle(vis, (int(full_l[y]), y), 1, (255, 0, 0), -1)
                    cv2.circle(vis, (int(full_r[y]), y), 1, (255, 0, 0), -1)
            cv2.imwrite(os.path.join(debug_dir, "bounds.png"),
                        cv2.resize(vis, None, fx=2.2, fy=2.2, interpolation=cv2.INTER_NEAREST))
            # карта зон и результат без фона — для численных проверок
            cv2.imwrite(os.path.join(debug_dir, "zones.png"), idx * 50)
            cv2.imwrite(os.path.join(debug_dir, "flat.png"), rgb)
        print("дебаг:", debug_dir)

    ys, xs = np.where(mask > 127)
    bx0, by0, bx1, by1 = xs.min(), ys.min(), xs.max() + 1, ys.max() + 1
    rgb = darken_rim(rgb, mask)
    alpha = soft_alpha(mask)
    rgba = cv2.cvtColor(rgb[by0:by1, bx0:bx1], cv2.COLOR_RGB2BGRA)
    rgba[:, :, 3] = alpha[by0:by1, bx0:bx1]
    if dst:
        ensure_parent_dir(dst)
        ok, buf = cv2.imencode(".webp", rgba, [int(cv2.IMWRITE_WEBP_QUALITY), quality])
        if not ok:
            raise SystemExit("не удалось закодировать webp")
        buf.tofile(dst)
        print(f"сохранено: {dst} ({os.path.getsize(dst)//1024} КБ, {bx1-bx0}x{by1-by0})")
    return rgba


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="src", required=True)
    ap.add_argument("--out", dest="dst")
    ap.add_argument("--axis", type=int, default=None)
    ap.add_argument("--no-head", action="store_true")
    ap.add_argument("--no-paint", action="store_true")
    ap.add_argument("--quality", type=int_range(1, 100, "--quality"), default=88)
    ap.add_argument("--debug-dir", default=None)
    a = ap.parse_args()
    process(a.src, a.dst, a.axis, not a.no_head, not a.no_paint, a.quality, a.debug_dir)


if __name__ == "__main__":
    main()
