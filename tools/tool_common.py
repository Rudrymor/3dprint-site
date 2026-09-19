#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Общее для tools/*.py: папки под вывод и проверка аргументов командной строки.

Пути вывода задаёт пользователь (--out, --preview, --debug-dir). Если папки ещё
нет, imencode(...).tofile(path) падает с FileNotFoundError — причём в самом конце
работы, после тяжёлой обработки. Поэтому каждый путь вывода сначала проходит через
ensure_parent_dir().
"""
import argparse
import os


def ensure_parent_dir(path):
    """Создаёт папку, в которой лежит path (сам файл не трогает)."""
    parent = os.path.dirname(os.path.abspath(path))
    if parent:
        os.makedirs(parent, exist_ok=True)
    return path


def int_range(lo, hi, what="значение"):
    """Тип для argparse: целое число в диапазоне lo..hi."""
    def parse(text):
        try:
            value = int(text)
        except ValueError:
            raise argparse.ArgumentTypeError(f"{what}: нужно целое число, получено {text!r}")
        if not lo <= value <= hi:
            raise argparse.ArgumentTypeError(f"{what}: допустимо {lo}..{hi}, получено {value}")
        return value

    return parse


def float_range(lo, hi, what="значение"):
    """Тип для argparse: дробное число в диапазоне lo..hi."""
    def parse(text):
        try:
            value = float(text)
        except ValueError:
            raise argparse.ArgumentTypeError(f"{what}: нужно число, получено {text!r}")
        if not lo <= value <= hi:
            raise argparse.ArgumentTypeError(f"{what}: допустимо {lo}..{hi}, получено {value}")
        return value

    return parse
