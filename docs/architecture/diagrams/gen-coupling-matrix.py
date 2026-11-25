#!/usr/bin/env python3
"""Строит матрицу связности модулей монолита по импортам.

Источник истины — Java-код: для каждого bounded context считаются импорты
`ru.krug.backend.<other>.*` и отдельно импорты `<other>.domain.*`.

Выход:
  - coupling-matrix.csv   — сырые данные;
  - coupling-matrix.md    — Markdown-таблица для документа;
  - svg/04-coupling-matrix.svg (+ png, если есть rsvg-convert).

Запуск из корня репозитория:
  python3 docs/architecture/diagrams/gen-coupling-matrix.py
"""
from __future__ import annotations

import csv
import html
import re
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
BACKEND = ROOT / "backend" / "src" / "main" / "java" / "ru" / "krug" / "backend"
OUT = Path(__file__).resolve().parent

CONTEXTS = [
    "auth", "workspace", "chat", "message", "file", "sticker", "notification",
    "plugin", "bot", "room", "realtime", "ops", "audit",
]
SHORT = {
    "auth": "auth", "workspace": "workspace", "chat": "chat", "message": "message",
    "file": "file", "sticker": "sticker", "notification": "notify", "plugin": "plugin",
    "bot": "bot", "room": "room", "realtime": "realtime", "ops": "ops", "audit": "audit",
}
IMPORT_RE = re.compile(r"^import\s+ru\.krug\.backend\.(\w+)\.")


def collect() -> tuple[dict[tuple[str, str], int], dict[tuple[str, str], int]]:
    totals: dict[tuple[str, str], int] = {}
    domains: dict[tuple[str, str], int] = {}
    for ctx in CONTEXTS:
        for java in (BACKEND / ctx).rglob("*.java"):
            for line in java.read_text(encoding="utf-8").splitlines():
                m = IMPORT_RE.match(line.strip())
                if not m:
                    continue
                other = m.group(1)
                if other not in CONTEXTS or other == ctx:
                    continue
                totals[(ctx, other)] = totals.get((ctx, other), 0) + 1
                if f".{other}.domain." in line:
                    domains[(ctx, other)] = domains.get((ctx, other), 0) + 1
    return totals, domains


def color(value: int, maximum: int) -> str:
    if value == 0:
        return "#FFFFFF"
    # белый -> насыщенный красный
    ratio = min(value / max(maximum, 1), 1.0)
    stops = [(255, 245, 245), (254, 178, 178), (252, 100, 100), (197, 48, 48)]
    pos = ratio * (len(stops) - 1)
    i = int(pos)
    j = min(i + 1, len(stops) - 1)
    t = pos - i
    rgb = tuple(round(stops[i][k] + (stops[j][k] - stops[i][k]) * t) for k in range(3))
    return "#{:02X}{:02X}{:02X}".format(*rgb)


def text_color(value: int, maximum: int) -> str:
    return "#FFFFFF" if value / max(maximum, 1) > 0.55 else "#1A202C"


def build_svg(totals: dict[tuple[str, str], int], domains: dict[tuple[str, str], int]) -> str:
    n = len(CONTEXTS)
    cell_w, cell_h = 58, 40
    left, top = 165, 190
    width = max(left + n * cell_w + 40, 1080)
    height = top + n * cell_h + 120
    maximum = max(totals.values(), default=1)
    out: list[str] = []
    out.append(
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
        f'viewBox="0 0 {width} {height}" font-family="Helvetica, Arial, sans-serif">'
    )
    out.append('<rect width="100%" height="100%" fill="#FFFFFF"/>')
    out.append(
        f'<text x="{left}" y="34" font-size="18" font-weight="bold" fill="#1A202C">'
        "Связность модулей «Сова»: импорты между bounded context</text>"
    )
    out.append(
        f'<text x="{left}" y="58" font-size="11" fill="#4A5568">'
        "Строка — откуда, столбец — куда; число — импортированных классов. "
        "Красная рамка — domain-класс чужого контекста.</text>"
    )

    # column labels
    for j, ctx in enumerate(CONTEXTS):
        x = left + j * cell_w + cell_w / 2
        y = top - 12
        out.append(
            f'<text x="{x}" y="{y}" font-size="10" fill="#2D3748" text-anchor="end" '
            f'transform="rotate(-55 {x} {y})">{html.escape(SHORT[ctx])}</text>'
        )
    # row labels + cells
    for i, ctx in enumerate(CONTEXTS):
        y = top + i * cell_h + cell_h / 2 + 4
        out.append(
            f'<text x="{left - 12}" y="{y}" font-size="11" fill="#2D3748" '
            f'text-anchor="end">{html.escape(SHORT[ctx])}</text>'
        )
        for j, other in enumerate(CONTEXTS):
            x = left + j * cell_w
            cy = top + i * cell_h
            value = totals.get((ctx, other), 0)
            if ctx == other:
                fill, label, stroke = "#EDF2F7", "", "#CBD5E0"
            else:
                fill = color(value, maximum)
                label = str(value) if value else ""
                stroke = "#E2E8F0"
            out.append(
                f'<rect x="{x}" y="{cy}" width="{cell_w}" height="{cell_h}" fill="{fill}" '
                f'stroke="{stroke}" stroke-width="1"/>'
            )
            if (ctx, other) in domains:
                out.append(
                    f'<rect x="{x + 2}" y="{cy + 2}" width="{cell_w - 4}" height="{cell_h - 4}" '
                    f'fill="none" stroke="#C53030" stroke-width="2"/>'
                )
            if label:
                out.append(
                    f'<text x="{x + cell_w / 2}" y="{cy + cell_h / 2 + 4}" font-size="11" '
                    f'fill="{text_color(value, maximum)}" text-anchor="middle">{label}</text>'
                )

    # legend
    lx, ly = left, height - 62
    out.append(f'<text x="{lx}" y="{ly}" font-size="11" fill="#4A5568">Легенда:</text>')
    for k, value in enumerate([1, 5, 10, 18, 25]):
        fill = color(value, maximum)
        out.append(
            f'<rect x="{lx + 65 + k * 44}" y="{ly - 10}" width="40" height="14" fill="{fill}" '
            f'stroke="#E2E8F0"/>'
        )
        out.append(
            f'<text x="{lx + 85 + k * 44}" y="{ly + 18}" font-size="9" fill="#4A5568" '
            f'text-anchor="middle">{value}</text>'
        )
    out.append(
        f'<rect x="{lx + 300}" y="{ly - 10}" width="16" height="14" fill="none" '
        f'stroke="#C53030" stroke-width="2"/>'
    )
    out.append(
        f'<text x="{lx + 322}" y="{ly + 2}" font-size="11" fill="#4A5568">'
        "есть импорт domain-классов чужого контекста</text>"
    )
    out.append("</svg>")
    return "\n".join(out)


def build_markdown(totals: dict[tuple[str, str], int], domains: dict[tuple[str, str], int]) -> str:
    head = "| from \\ to | " + " | ".join(SHORT[c] for c in CONTEXTS) + " |"
    sep = "|---|" + "---|" * len(CONTEXTS)
    rows = [head, sep]
    for ctx in CONTEXTS:
        cells = []
        for other in CONTEXTS:
            if ctx == other:
                cells.append("·")
                continue
            value = totals.get((ctx, other), 0)
            if value and (ctx, other) in domains:
                cells.append(f"**{value}**")
            else:
                cells.append(str(value) if value else "")
        rows.append(f"| **{SHORT[ctx]}** | " + " | ".join(cells) + " |")
    return "\n".join(rows) + "\n"


def main() -> None:
    totals, domains = collect()
    (OUT / "coupling-matrix.csv").write_text(
        "from,to,imports,domain_imports\n"
        + "\n".join(
            f"{a},{b},{n},{domains.get((a, b), 0)}"
            for (a, b), n in sorted(totals.items(), key=lambda kv: (-kv[1], kv[0]))
        )
        + "\n",
        encoding="utf-8",
    )
    (OUT / "coupling-matrix.md").write_text(build_markdown(totals, domains), encoding="utf-8")
    svg = build_svg(totals, domains)
    svg_path = OUT / "svg" / "04-coupling-matrix.svg"
    svg_path.write_text(svg, encoding="utf-8")

    if shutil.which("rsvg-convert"):
        subprocess.run(
            ["rsvg-convert", "-f", "png", "-o", str(OUT / "png" / "04-coupling-matrix.png"), str(svg_path)],
            check=True,
        )
    print(f"Готово: {svg_path}")
    print(f"Связей: {len(totals)}, из них с domain-импортами: {len(domains)}")


if __name__ == "__main__":
    main()
