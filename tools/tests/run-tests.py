#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Тесты tools/*.py. Фикстуры генерируются на месте, сеть не используется.

Запуск: python tools/tests/run-tests.py

Проверяем два обещания инструментов: (1) на пустом/битом входе — понятное
сообщение и ненулевой код вместо трейсбека; (2) новые пути вывода (папки,
кириллица) не ломают запись.
"""
import os
import shutil
import subprocess
import sys
import tempfile

import cv2
import numpy as np

TOOLS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(TOOLS)
PY = sys.executable

WORK = ""
FIX = {}
CASES = []


def case(name):
    def deco(fn):
        CASES.append((name, fn))
        return fn
    return deco


# ───────────────────────────── запуск и проверки ─────────────────────────────
def run_tool(script, *args, timeout=600):
    env = os.environ.copy()
    for key in list(env):
        if key.startswith("CLOUDFLARE_"):
            env.pop(key)                      # тесты не должны получить живой токен
    env["PYTHONIOENCODING"] = "utf-8"
    proc = subprocess.run([PY, os.path.join(TOOLS, script), *args],
                          cwd=REPO, env=env, capture_output=True, text=True,
                          encoding="utf-8", errors="replace", timeout=timeout)
    proc.all = (proc.stdout or "") + (proc.stderr or "")
    return proc


def expect_fail(proc, marker, what):
    assert proc.returncode != 0, f"{what}: ожидался ненулевой код, получено {proc.returncode}\n{proc.all}"
    assert "Traceback" not in proc.all, f"{what}: в выводе трейсбек:\n{proc.all}"
    assert "ZeroDivisionError" not in proc.all, f"{what}: ZeroDivisionError вернулся:\n{proc.all}"
    assert marker in proc.all, f"{what}: в выводе нет {marker!r}:\n{proc.all}"


def expect_ok(proc, what):
    assert proc.returncode == 0, f"{what}: код {proc.returncode}\n{proc.all}"
    assert "Traceback" not in proc.all, f"{what}: в выводе трейсбек:\n{proc.all}"


def out(name):
    path = os.path.join(WORK, "out", name)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    return path


def save_png(path, img):
    ok, buf = cv2.imencode(".png", img)
    assert ok, f"фикстура не закодировалась: {path}"
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    buf.tofile(path)
    return path


def save_webp_rgba(path, color):
    img = np.zeros((240, 160, 4), np.uint8)
    cv2.ellipse(img, (80, 130), (48, 100), 0, 0, 360, (*color, 255), -1)
    ok, buf = cv2.imencode(".webp", img)
    assert ok
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    buf.tofile(path)
    return path


# ───────────────────────────── фикстуры ─────────────────────────────
def build_fixtures(root):
    black = np.zeros((200, 120, 3), np.uint8)
    FIX["black"] = save_png(os.path.join(root, "black.png"), black)
    FIX["white"] = save_png(os.path.join(root, "white.png"), np.full((200, 120, 3), 255, np.uint8))

    dot = black.copy()
    dot[100, 60] = 255
    FIX["dot"] = save_png(os.path.join(root, "dot.png"), dot)

    tiny = black.copy()
    tiny[96:104, 56:64] = 255
    FIX["tiny"] = save_png(os.path.join(root, "tiny.png"), tiny)

    good = np.full((240, 160, 3), 15, np.uint8)
    cv2.ellipse(good, (80, 130), (48, 100), 0, 0, 360, (240, 240, 240), -1)
    FIX["good"] = save_png(os.path.join(root, "good.png"), good)
    FIX["hero"] = FIX["good"]

    rgba = np.zeros((240, 160, 4), np.uint8)
    cv2.ellipse(rgba, (80, 130), (48, 100), 0, 0, 360, (240, 240, 240, 255), -1)
    FIX["rgba"] = save_png(os.path.join(root, "rgba.png"), rgba)

    FIX["broken"] = os.path.join(root, "broken.png")
    with open(FIX["broken"], "wb") as f:
        f.write(b"this is definitely not an image\x00\x01")

    FIX["cyr_in"] = save_png(os.path.join(root, "фигурки", "игрушка тест.png"), good)
    FIX["cyr_out"] = os.path.join(root, "фигурки", "вывод", "ассет.webp")

    FIX["old"] = save_webp_rgba(os.path.join(root, "old.webp"), (90, 90, 200))
    FIX["new"] = save_webp_rgba(os.path.join(root, "new.webp"), (200, 90, 90))


# ───────────────────────────── PY-01 ─────────────────────────────
@case("PY-01: чёрная картинка — отказ без трейсбека")
def t_black():
    p = run_tool("figure_from_ai.py", "--in", FIX["black"], "--out", out("black.webp"))
    expect_fail(p, "не удалось отделить фигурку", "чёрная картинка")


@case("PY-01: чёрная картинка, --method otsu — проверка маски объясняет причину")
def t_black_otsu():
    p = run_tool("figure_from_ai.py", "--in", FIX["black"], "--out", out("black2.webp"), "--method", "otsu")
    expect_fail(p, "фигурка не найдена", "чёрная картинка/otsu")


@case("PY-01: белая картинка — отказ без трейсбека")
def t_white():
    p = run_tool("figure_from_ai.py", "--in", FIX["white"], "--out", out("white.webp"))
    expect_fail(p, "не удалось отделить фигурку", "белая картинка")


@case("PY-01: одна белая точка — отказ без трейсбека")
def t_dot():
    p = run_tool("figure_from_ai.py", "--in", FIX["dot"], "--out", out("dot.webp"))
    expect_fail(p, "не удалось отделить фигурку", "точка")


@case("PY-01: 8x8 пятно — отказ «слишком маленькое пятно»")
def t_tiny():
    p = run_tool("figure_from_ai.py", "--in", FIX["tiny"], "--out", out("tiny.webp"))
    expect_fail(p, "слишком маленькое пятно", "мелкое пятно")


@case("PY-01: повреждённый файл — «не удалось прочитать»")
def t_broken():
    p = run_tool("figure_from_ai.py", "--in", FIX["broken"], "--out", out("broken.webp"))
    expect_fail(p, "не удалось прочитать", "битый файл")


@case("PY-01: --height 0 отклоняется до работы")
def t_height0():
    p = run_tool("figure_from_ai.py", "--in", FIX["good"], "--out", out("h0.webp"), "--height", "0")
    expect_fail(p, "допустимо", "--height 0")


# ───────────────────────────── PY-02 ─────────────────────────────
@case("PY-02: figure_from_ai создаёт вложенные папки output и обоих превью")
def t_outdirs():
    dst = os.path.join(WORK, "new", "a", "b", "asset.webp")
    prev = os.path.join(WORK, "new", "p", "preview.png")
    prev_light = os.path.join(WORK, "new", "p", "preview-light.png")
    p = run_tool("figure_from_ai.py", "--in", FIX["good"], "--out", dst,
                 "--preview", prev, "--preview-light", prev_light)
    expect_ok(p, "новые папки вывода")
    for path in (dst, prev, prev_light):
        assert os.path.exists(path), f"не создан файл: {path}\n{p.all}"
    assert "сохранено:" in p.stdout


@case("PY-02: RGBA-вход обрабатывается")
def t_rgba():
    dst = out("rgba.webp")
    p = run_tool("figure_from_ai.py", "--in", FIX["rgba"], "--out", dst, "--height", "200")
    expect_ok(p, "RGBA-вход")
    assert os.path.exists(dst)


@case("PY-02: кириллические пути входа и выхода")
def t_cyrillic():
    p = run_tool("figure_from_ai.py", "--in", FIX["cyr_in"], "--out", FIX["cyr_out"], "--height", "200")
    expect_ok(p, "кириллица")
    assert os.path.exists(FIX["cyr_out"]), p.all


@case("PY-02: ai_repaint создаёт папку вывода и не зовёт сеть без токена")
def t_repaint_no_token():
    dst = os.path.join(WORK, "repaint", "deep", "out.png")
    p = run_tool("ai_repaint.py", "--in", FIX["good"], "--out", dst,
                 "--env", os.path.join(WORK, "нет-такого.env"))
    expect_fail(p, "Нет CLOUDFLARE_API_TOKEN", "ai_repaint без токена")
    assert not os.path.exists(dst), "файл не должен появиться без токена"


@case("PY-02: ai_repaint --check без токена работает и не падает")
def t_repaint_check():
    p = run_tool("ai_repaint.py", "--check", "--env", os.path.join(WORK, "нет-такого.env"))
    expect_ok(p, "ai_repaint --check")
    assert "CLOUDFLARE_API_TOKEN: НЕТ" in p.all, p.all


@case("PY-02: ai_repaint отклоняет --steps 0, --strength 2, --width 100")
def t_repaint_args():
    base = ["--in", FIX["good"], "--out", out("never.png"), "--env", os.path.join(WORK, "нет-такого.env")]
    for extra, marker in ((["--steps", "0"], "--steps"), (["--strength", "2"], "--strength"),
                          (["--width", "100"], "--width")):
        p = run_tool("ai_repaint.py", *base, *extra)
        expect_fail(p, "допустимо", f"ai_repaint {marker}")


# ───────────────────────────── PY-03 ─────────────────────────────
@case("PY-03: --axis 0 сохраняет ноль, авто-расчёт не подменяет значение")
def t_axis0():
    p = run_tool("figure_hero.py", "--in", FIX["hero"], "--out", out("axis0.webp"),
                 "--no-paint", "--axis", "0")
    expect_ok(p, "--axis 0")
    assert "ось симметрии x=0" in p.stdout, p.all


@case("PY-03: --axis вне картинки — понятный отказ")
def t_axis_far():
    p = run_tool("figure_hero.py", "--in", FIX["hero"], "--out", out("axisfar.webp"), "--axis", "99999")
    expect_fail(p, "за пределами фигурки", "--axis 99999")


@case("PY-03: figure_hero без --axis проходит весь путь и пишет webp")
def t_hero_full():
    dst = os.path.join(WORK, "hero", "sub", "figure-hero.webp")
    p = run_tool("figure_hero.py", "--in", FIX["hero"], "--out", dst)
    expect_ok(p, "figure_hero полный прогон")
    assert os.path.exists(dst), p.all
    img = cv2.imdecode(np.fromfile(dst, dtype=np.uint8), cv2.IMREAD_UNCHANGED)
    assert img is not None and img.shape[2] == 4, "на выходе должен быть webp с альфой"


@case("PY-03: figure_hero --quality 0 отклоняется")
def t_hero_quality():
    p = run_tool("figure_hero.py", "--in", FIX["hero"], "--out", out("q0.webp"), "--quality", "0")
    expect_fail(p, "допустимо", "figure_hero --quality 0")


@case("PY-03: figure_hero --debug-dir создаёт вложенную папку")
def t_hero_debug():
    dbg = os.path.join(WORK, "dbg", "inner")
    p = run_tool("figure_hero.py", "--in", FIX["hero"], "--out", out("dbg.webp"), "--debug-dir", dbg)
    expect_ok(p, "figure_hero --debug-dir")
    assert os.path.exists(os.path.join(dbg, "paint_preview.png")), os.listdir(dbg) if os.path.isdir(dbg) else "нет папки"


# ───────────────────────────── PY-04 ─────────────────────────────
@case("PY-04: edge_report с обоими ассетами — метрики и карточка")
def t_edge_both():
    review = os.path.join(WORK, "review")
    p = run_tool("edge_report.py", "--old", FIX["old"], "--new", FIX["new"],
                 "--broken", os.path.join(WORK, "нет.webp"), "--review-dir", review)
    expect_ok(p, "edge_report")
    assert "ЯРКОСТЬ КРОМКИ" in p.stdout and "карточка:" in p.stdout, p.all
    assert os.path.exists(os.path.join(review, "C-before-after-and-halo.png")), p.all
    assert "пропущено" in p.stdout, "отсутствующий третий ассет должен быть помечен"


@case("PY-04: edge_report без файла «было» — работает и честно предупреждает")
def t_edge_no_old():
    review = os.path.join(WORK, "review2")
    p = run_tool("edge_report.py", "--old", os.path.join(WORK, "нет-old.webp"),
                 "--new", FIX["new"], "--review-dir", review)
    expect_ok(p, "edge_report без «было»")
    assert "пропущено" in p.stdout, p.all
    assert os.path.exists(os.path.join(review, "C-before-after-and-halo.png")), p.all


@case("PY-04: edge_report без основного ассета — понятный отказ")
def t_edge_no_new():
    p = run_tool("edge_report.py", "--new", os.path.join(WORK, "нет-new.webp"),
                 "--review-dir", os.path.join(WORK, "review3"))
    expect_fail(p, "основной ассет не найден", "edge_report без «стало»")


@case("PY-04: в tools/*.py нет жёстких путей C:\\Users\\...")
def t_no_abs_paths():
    bad = []
    for name in sorted(os.listdir(TOOLS)):
        if not name.endswith(".py"):
            continue
        text = open(os.path.join(TOOLS, name), encoding="utf-8").read()
        for pat in ("C:\\Users", "C:/Users"):
            if pat in text:
                bad.append(f"{name}: {pat}")
    assert not bad, f"жёсткие пути остались: {bad}"


# ───────────────────────────── общие проверки ─────────────────────────────
@case("GATE: python -m compileall -q tools")
def t_compileall():
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    p = subprocess.run([PY, "-m", "compileall", "-q", "tools"], cwd=REPO, env=env,
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    assert p.returncode == 0, p.stdout + p.stderr


def main():
    global WORK
    WORK = tempfile.mkdtemp(prefix="tools-tests-")
    build_fixtures(WORK)
    passed, failed = 0, []
    try:
        for name, fn in CASES:
            try:
                fn()
            except Exception as exc:                       # noqa: BLE001 — отчёт важнее типа
                failed.append((name, f"{type(exc).__name__}: {exc}"))
                print(f"  FAIL  {name}")
                print(f"        {type(exc).__name__}: {exc}")
            else:
                passed += 1
                print(f"  ok    {name}")
    finally:
        shutil.rmtree(WORK, ignore_errors=True)
    print()
    print(f"{passed}/{len(CASES)} тестов tools прошло")
    if failed:
        print("не прошло:")
        for name, err in failed:
            print(f"  ! {name}: {err}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
