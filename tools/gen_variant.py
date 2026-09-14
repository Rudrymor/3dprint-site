#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Воспроизводимая генерация вариантов покраски фигурки (Cloudflare Workers AI, FLUX.2 klein).

Зачем: в первой итерации промпты жили только в истории чата, поэтому варианты V1–V4
нельзя было повторить. Здесь промпты — часть репозитория, а не переписка.

Примеры:
  # только сгенерировать картинку (768x1408, ~245 нейронов за вызов)
  python tools/gen_variant.py --variant V1 --out tmp/v1b.png --seed 7

  # сгенерировать и сразу собрать готовый ассет + превью
  python tools/gen_variant.py --variant V1 --out tmp/v1b.png --seed 7 \
      --asset images/figure-hero.webp --height 593 \
      --preview tmp/v1b_dark.png --preview-light tmp/v1b_light.png

Промпты про клейн:
  * негативный промпт не поддерживается — все запреты идут в положительный текст
    («both legs fully visible», а не «no missing leg»);
  * pose klein придумывает сам поверх референса, поэтому требование про обе ноги
    нужно писать явно, иначе фигурка «уходит в шаг» и одна нога пропадает;
  * steps зафиксирован = 4, референсы строго < 512x512 (ужимает ai_repaint.py).
"""
import argparse
import os
import subprocess
import sys

TOOLS = os.path.dirname(os.path.abspath(__file__))

# Цветовая основа у всех вариантов одна — расходится только палитра,
# чтобы владелец выбирал из готовых ассетов, а не пересобирал их заново.
POSE = ("standing upright facing the camera, full body from cap to sneakers, "
        "standing on both feet planted apart, both legs fully visible from hip to sneaker, "
        "both paws visible at the sides, wide stance")

STYLE = ("painted 3d printed collectible cat figurine, glossy clean paint job, "
         "product photo on plain dark background, soft studio light, sharp focus")

VARIANTS = {
    "V1": {
        "note": "белая кепка с чёрным ICON, оранжевая шерсть, синее худи, фиолетовые кроссовки (одобрен владельцем)",
        "prompt": (f"{STYLE}, plain white baseball cap with black ICON lettering on the front, "
                   f"bright orange fur on face ears and paws, deep blue hoodie with hood and drawstrings, "
                   f"purple sneakers with light lavender soles, {POSE}"),
    },
    "V2": {
        "note": "как V1, но глаза полузакрыты как в оригинале",
        "prompt": (f"{STYLE}, plain white baseball cap with black ICON lettering on the front, "
                   f"bright orange fur on face ears and paws, deep blue hoodie with hood and drawstrings, "
                   f"purple sneakers with light lavender soles, eyes half closed sleepy expression, {POSE}"),
    },
    "V3": {
        "note": "чёрная кепка с оранжевым ICON, графитовая шерсть, тёмно-бирюзовое худи",
        "prompt": (f"{STYLE}, black baseball cap with orange ICON lettering on the front, "
                   f"graphite grey fur on face ears and paws, dark teal hoodie with hood and drawstrings, "
                   f"white sneakers with grey soles, {POSE}"),
    },
    "V4": {
        "note": "красная кепка, кремовая шерсть, горчичное худи",
        "prompt": (f"{STYLE}, dark red baseball cap with white ICON lettering on the front, "
                   f"cream colored fur on face ears and paws, mustard yellow hoodie with hood and drawstrings, "
                   f"black sneakers with white soles, {POSE}"),
    },
}


def main():
    ap = argparse.ArgumentParser(description="Генерация варианта покраски фигурки (klein)")
    ap.add_argument("--variant", choices=sorted(VARIANTS), required=True)
    ap.add_argument("--in", dest="src", default=os.path.join(TOOLS, "..", "assets", "cat-unpainted.png"),
                    help="референс формы (некрашеная фигурка)")
    ap.add_argument("--out", dest="dst", required=True, help="куда положить сырую генерацию")
    ap.add_argument("--ref", action="append", default=[],
                    help="доп. референс (например, рендер в целевых цветах); до 3 штук")
    ap.add_argument("--seed", type=int, default=None)
    ap.add_argument("--guidance", type=float, default=4.0)
    ap.add_argument("--width", type=int, default=768)
    ap.add_argument("--height", type=int, default=1408)
    ap.add_argument("--prompt", default=None, help="перебить промпт варианта вручную")
    ap.add_argument("--asset", default=None, help="сразу собрать ассет через figure_from_ai.py")
    ap.add_argument("--asset-height", type=int, default=593)
    ap.add_argument("--preview", default=None)
    ap.add_argument("--preview-light", default=None)
    args = ap.parse_args()

    v = VARIANTS[args.variant]
    prompt = args.prompt or v["prompt"]
    print(f"вариант {args.variant} — {v['note']}")
    print("промпт:", prompt)

    cmd = [sys.executable, os.path.join(TOOLS, "ai_repaint.py"), "--mode", "klein",
           "--in", args.src, "--out", args.dst,
           "--width", str(args.width), "--height", str(args.height),
           "--guidance", str(args.guidance), "--prompt", prompt]
    for r in args.ref:
        cmd += ["--ref", r]
    if args.seed is not None:
        cmd += ["--seed", str(args.seed)]
    subprocess.run(cmd, check=True)

    if not args.asset:
        return
    acmd = [sys.executable, os.path.join(TOOLS, "figure_from_ai.py"),
            "--in", args.dst, "--out", args.asset, "--height", str(args.asset_height)]
    if args.preview:
        acmd += ["--preview", args.preview]
    if args.preview_light:
        acmd += ["--preview-light", args.preview_light]
    subprocess.run(acmd, check=True)


if __name__ == "__main__":
    main()
