#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
AI-раскраска / дорисовка фигурки через Cloudflare Workers AI (бесплатный тариф).

Зачем: ручная покраска по зонам даёт плоскую заливку. Модели SD1.5 могут
перекрасить реальную фотографию печати с сохранением формы, света и слоистости.

Бэкенды:
  img2img  @cf/runwayml/stable-diffusion-v1-5-img2img    $0.00/шаг (бесплатно)
  inpaint  @cf/runwayml/stable-diffusion-v1-5-inpainting $0.00/шаг (бесплатно)
  klein    @cf/black-forest-labs/flux-2-klein-4b         ~130 нейронов/картинка

Ключи (.env в корне проекта, в git не попадает):
  CLOUDFLARE_API_TOKEN=...
  CLOUDFLARE_ACCOUNT_ID=...

Примеры:
  python tools/ai_repaint.py --check
  python tools/ai_repaint.py --in figure.png --mode img2img --strength 0.5 \
      --prompt "painted collectible figurine, orange fur, blue hoodie" --out out.png
  python tools/ai_repaint.py --in figure.png --mask ear_mask.png --mode inpaint \
      --prompt "orange cat ear, fur" --out out.png

Кириллические пути: чтение/запись только через np.fromfile/imdecode и imencode.
"""
import argparse
import base64
import json
import os
import sys
import urllib.error
import urllib.request
import uuid

import cv2
import numpy as np

API = "https://api.cloudflare.com/client/v4"
MODELS = {
    "img2img": "@cf/runwayml/stable-diffusion-v1-5-img2img",
    "inpaint": "@cf/runwayml/stable-diffusion-v1-5-inpainting",
    "klein": "@cf/black-forest-labs/flux-2-klein-4b",
}


def load_env(paths):
    """Читает .env в корне проекта; значения в переменных окружения приоритетнее."""
    env = {}
    for p in paths:
        if not os.path.exists(p):
            continue
        with open(p, encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip().strip('"').strip("'")
    for k in ("CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"):
        if os.environ.get(k):
            env[k] = os.environ[k]
    return env


def read_img(path):
    """cv2.imread не понимает кириллицу в пути — читаем байтами."""
    buf = np.fromfile(path, dtype=np.uint8)
    img = cv2.imdecode(buf, cv2.IMREAD_UNCHANGED)
    if img is None:
        raise SystemExit(f"не удалось прочитать: {path}")
    return img


def write_img(path, img, is_bgr=True):
    ext = os.path.splitext(path)[1].lower() or ".png"
    ok, buf = cv2.imencode(ext, img)
    if not ok:
        raise SystemExit(f"не удалось закодировать: {path}")
    buf.tofile(path)
    return len(buf)


def png_bytes_to_bgr(raw):
    arr = np.frombuffer(raw, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_UNCHANGED)
    if img is None:
        raise SystemExit("ответ модели не является изображением")
    if img.ndim == 3 and img.shape[2] == 4:
        return img
    return img


def build_multipart(fields, files):
    """Собирает multipart/form-data вручную (stdlib): поля + бинарные файлы."""
    boundary = "----hermes" + uuid.uuid4().hex
    out = bytearray()
    for k, v in fields.items():
        out += f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode()
    for k, (fname, data, ctype) in files.items():
        out += (
            f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"; filename="{fname}"\r\n'
            f"Content-Type: {ctype}\r\n\r\n"
        ).encode()
        out += data + b"\r\n"
    out += f"--{boundary}--\r\n".encode()
    return bytes(out), f"multipart/form-data; boundary={boundary}"


def call_cf(model, payload, env, timeout=300, files=None):
    acc = env.get("CLOUDFLARE_ACCOUNT_ID") or ""
    tok = env.get("CLOUDFLARE_API_TOKEN") or ""
    if not tok:
        raise SystemExit(
            "Нет CLOUDFLARE_API_TOKEN.\n"
            "Возьми на https://dash.cloudflare.com/?to=/:account/ai/workers-ai →\n"
            "  «Use REST API» → Create a Workers AI API Token,\n"
            "и положи в .env рядом с ACCOUNT_ID (в чат токен не отправляй)."
        )
    if not acc:
        raise SystemExit("Нет CLOUDFLARE_ACCOUNT_ID в .env (он указан там же, где токен).")
    url = f"{API}/accounts/{acc}/ai/run/{model}"
    if files:
        body, ctype = build_multipart(payload, files)
    else:
        body, ctype = json.dumps(payload).encode(), "application/json"
    req = urllib.request.Request(
        url, data=body, headers={
            "Authorization": f"Bearer {tok}",
            "Content-Type": ctype,
        })
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            ctype = resp.headers.get("content-type", "")
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:600]
        raise SystemExit(f"HTTP {e.code} от Cloudflare:\n{detail}")
    except urllib.error.URLError as e:
        raise SystemExit(f"сеть недоступна: {e}")

    # Ответ бывает либо бинарным PNG, либо JSON с base64 (или с ошибкой)
    if ctype.startswith("image/") or raw[:4] in (b"\x89PNG", b"\xff\xd8\xff\xe0"):
        return raw
    try:
        data = json.loads(raw)
    except Exception:
        return raw
    if not data.get("success", True):
        raise SystemExit("Cloudflare вернул ошибку:\n" + json.dumps(data, ensure_ascii=False)[:800])
    res = data.get("result", data)
    if isinstance(res, dict) and isinstance(res.get("image"), str):
        return base64.b64decode(res["image"])
    raise SystemExit("в ответе нет картинки:\n" + json.dumps(data, ensure_ascii=False)[:600])


def check(env):
    tok = env.get("CLOUDFLARE_API_TOKEN") or ""
    acc = env.get("CLOUDFLARE_ACCOUNT_ID") or ""
    print("CLOUDFLARE_API_TOKEN:", f"есть ({len(tok)} симв.)" if tok else "НЕТ")
    print("CLOUDFLARE_ACCOUNT_ID:", acc if acc else "НЕТ")
    if not tok:
        return
    req = urllib.request.Request(f"{API}/accounts", headers={"Authorization": f"Bearer {tok}"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            data = json.loads(r.read())
        ok = data.get("success")
        ids = [a["id"] for a in (data.get("result") or [])]
        print(f"токен валиден: {ok}; аккаунтов доступно: {len(ids)}")
        for i in ids:
            print("  account_id:", i)
        if ids and not acc:
            print("подсказка: впиши один из account_id в .env как CLOUDFLARE_ACCOUNT_ID")
    except urllib.error.HTTPError as e:
        print("проверка токена: HTTP", e.code, e.read()[:200])
    except Exception as e:
        print("проверка токена не удалась:", e)


def main():
    ap = argparse.ArgumentParser(description="AI-покраска фигурки через Cloudflare Workers AI")
    ap.add_argument("--check", action="store_true", help="проверить токен и показать account_id")
    ap.add_argument("--in", dest="src", help="входная картинка")
    ap.add_argument("--out", dest="dst", help="куда сохранить результат")
    ap.add_argument("--mask", help="маска для inpaint (белое = перерисовать)")
    ap.add_argument("--mode", choices=list(MODELS), default="img2img")
    ap.add_argument("--prompt", default="painted 3d printed collectible figurine, clean paint job, product photo")
    ap.add_argument("--negative", default="blurry, distorted, extra limbs, text, watermark, low quality")
    ap.add_argument("--strength", type=float, default=0.5, help="img2img: 0=не трогать, 1=перерисовать целиком")
    ap.add_argument("--steps", type=int, default=20)
    ap.add_argument("--guidance", type=float, default=7.5)
    ap.add_argument("--seed", type=int, default=None)
    ap.add_argument("--width", type=int, default=768, help="klein: ширина результата (256-1920)")
    ap.add_argument("--height", type=int, default=1408, help="klein: высота результата (256-1920)")
    ap.add_argument("--ref", action="append", default=[], help="klein: доп. референс (можно несколько, до 3)")
    ap.add_argument("--env", default=None, help="путь к .env (по умолчанию — корень проекта)")
    args = ap.parse_args()

    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    env = load_env([args.env] if args.env else [os.path.join(root, ".env")])

    if args.check:
        check(env)
        return
    if not args.src or not args.dst:
        raise SystemExit("нужны --in и --out (или --check)")

    img = read_img(args.src)
    if img.ndim == 2:
        img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)

    # В PNG с альфой подкладываем тёмный фон, чтобы модель не «дорисовывала» прозрачность
    if img.shape[2] == 4:
        alpha = img[:, :, 3:4].astype(np.float32) / 255.0
        bg = np.full_like(img[:, :, :3], 15, dtype=np.uint8)  # #0f0f0f — фон сайта
        rgb = (img[:, :, :3].astype(np.float32) * alpha + bg * (1 - alpha)).astype(np.uint8)
        img = rgb

    h, w = img.shape[:2]
    # SD1.5 обучена на 512px: приводим сторону к кратному 64 и не больше 1024
    scale = min(1024 / max(h, w), 1.0)
    if max(h, w) > 1024:
        img = cv2.resize(img, (int(w * scale) // 64 * 64, int(h * scale) // 64 * 64), interpolation=cv2.INTER_AREA)

    payload = {"prompt": args.prompt, "negative_prompt": args.negative,
               "num_steps": args.steps, "guidance": args.guidance}
    if args.seed is not None:
        payload["seed"] = args.seed

    files = None
    if args.mode == "klein":
        # FLUX.2 [klein]: multipart/form-data, входы input_image_0..3, каждый строго < 512x512,
        # steps жёстко 4 (дистиллированная модель), негативный промпт не поддерживается.
        def prep_ref(im):
            hh, ww = im.shape[:2]
            s = min(511.0 / max(hh, ww), 1.0)
            if s < 1.0:
                im = cv2.resize(im, (max(1, int(ww * s)), max(1, int(hh * s))), interpolation=cv2.INTER_AREA)
            return cv2.imencode(".png", im)[1].tobytes()

        files = {"input_image_0": ("ref0.png", prep_ref(img), "image/png")}
        for i, rp in enumerate(args.ref[:3], start=1):
            files[f"input_image_{i}"] = (f"ref{i}.png", prep_ref(read_img(rp)), "image/png")
        payload = {"prompt": args.prompt, "width": args.width, "height": args.height}
        if args.guidance:
            payload["guidance"] = args.guidance
        if args.seed is not None:
            payload["seed"] = args.seed
        print(f"klein: референсов {len(files)}, они ужаты до <512px; выход {args.width}x{args.height}")
    else:
        payload["image_b64"] = base64.b64encode(cv2.imencode(".png", img)[1].tobytes()).decode()
        payload["strength"] = args.strength
        # SD1.5 работает на 512-768: сообщаем размер явно, кратный 64
        ph, pw = img.shape[:2]
        payload["width"] = max(256, min(1024, (pw // 64) * 64 or 256))
        payload["height"] = max(256, min(1024, (ph // 64) * 64 or 256))
        if args.mode == "inpaint":
            if not args.mask:
                raise SystemExit("для inpaint нужна --mask")
            m = read_img(args.mask)
            if m.ndim == 3:
                m = cv2.cvtColor(m, cv2.COLOR_BGR2GRAY)
            if m.shape[:2] != img.shape[:2]:
                m = cv2.resize(m, (img.shape[1], img.shape[0]), interpolation=cv2.INTER_NEAREST)
            payload["mask"] = (m > 127).astype(np.uint8).flatten().tolist()

    print(f"модель: {MODELS[args.mode]}  вход: {img.shape[1]}x{img.shape[0]}")
    raw = call_cf(MODELS[args.mode], payload, env, files=files)
    out = png_bytes_to_bgr(raw)
    n = write_img(args.dst, out)
    print(f"сохранено: {args.dst} ({n // 1024} КБ, {out.shape[1]}x{out.shape[0]})")


if __name__ == "__main__":
    main()
