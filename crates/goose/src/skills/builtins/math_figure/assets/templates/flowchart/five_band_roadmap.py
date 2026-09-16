"""Five-band technology roadmap (五带技术路线图).

A vertical roadmap used at the front of a modeling paper: five horizontal bands,
each a stage, with the concrete methods listed per stage and an arrow running down
the side to show the direction of work.

Run directly::

    uv run --with matplotlib python five_band_roadmap.py -o out/roadmap.pdf
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from _style import (  # noqa: E402
    BLOCK_FILL,
    BLOCK_FILL_ACCENT,
    PALETTE,
    apply_style,
    arrow,
    block,
    diagram_axes,
    enable_utf8_stdout,
    resolve_cjk_font,
    save_figure,
    title_and_note,
)

ZH_STAGES = [
    ("提出问题", ["赛题背景", "附件数据", "子问题拆解"]),
    ("数据预处理", ["缺失与异常处理", "量纲统一", "描述性统计"]),
    ("模型建立", ["机理/统计建模", "参数辨识", "模型对比"]),
    ("求解与检验", ["数值求解", "灵敏度分析", "误差评估"]),
    ("评价与推广", ["模型优缺点", "适用边界", "推广方向"]),
]

EN_STAGES = [
    ("Problem framing", ["Background", "Attachments", "Sub-questions"]),
    ("Data preparation", ["Missing values", "Normalisation", "Descriptives"]),
    ("Model building", ["Mechanistic / statistical", "Calibration", "Comparison"]),
    ("Solve and validate", ["Numerical solve", "Sensitivity", "Error metrics"]),
    ("Evaluate and extend", ["Strengths", "Limits", "Extensions"]),
]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("-o", "--output", default="out/roadmap.pdf")
    parser.add_argument("--lang", choices=["auto", "zh", "en"], default="auto")
    args = parser.parse_args()
    enable_utf8_stdout()

    try:
        import matplotlib.pyplot as plt
    except ImportError as exc:
        print(f"matplotlib is required: {exc}", file=sys.stderr)
        return 2

    use_zh = args.lang == "zh" or (args.lang == "auto" and resolve_cjk_font() is not None)
    stages = ZH_STAGES if use_zh else EN_STAGES
    heading = "技术路线图" if use_zh else "Technology roadmap"
    note = "演示结构，替换为你的实际方法与数据" if use_zh else "Demo structure — replace with your own methods"

    apply_style()
    fig, ax = diagram_axes(figsize=(7.4, 5.2))

    margin = 0.6
    band_height = 0.78
    gap = 0.34
    total = len(stages) * band_height + (len(stages) - 1) * gap
    top = total + 0.2

    label_width = 1.75
    rail_x = margin + label_width / 2
    content_x = margin + label_width + 0.35
    content_width = 5.6
    per_item = content_width / max(len(stages[0][1]), 1)

    for index, (name, items) in enumerate(stages):
        y = top - (index + 1) * band_height - index * gap

        # Stage label rides on the arrow rail, so the arrow reads as the timeline.
        block(
            ax,
            margin,
            y,
            label_width,
            band_height,
            name,
            fill=PALETTE["primary"],
            edge=PALETTE["primary"],
            text_color="#FFFFFF",
            fontsize=8.2,
        )

        # Stage content band.
        block(
            ax,
            content_x,
            y,
            content_width,
            band_height,
            "",
            fill=BLOCK_FILL,
            edge=PALETTE["tertiary"],
        )
        for item_index, item in enumerate(items):
            item_x = content_x + 0.14 + item_index * per_item
            block(
                ax,
                item_x,
                y + 0.13,
                per_item - 0.28,
                band_height - 0.26,
                item,
                fill=BLOCK_FILL_ACCENT if index == 2 else "#FFFFFF",
                edge=PALETTE["tertiary"],
                fontsize=6.8,
                radius=0.08,
            )

        if index < len(stages) - 1:
            arrow(
                ax,
                (rail_x, y),
                (rail_x, y - gap),
                color=PALETTE["secondary"],
            )

    arrow(ax, (rail_x, top), (rail_x, top - band_height + 0.12), color=PALETTE["tertiary"])

    ax.set_xlim(0, margin * 2 + label_width + 0.35 + content_width)
    ax.set_ylim(top - total - 0.45, top + 0.35)
    title_and_note(ax, heading, note)

    fig.tight_layout()

    written = save_figure(fig, args.output)
    plt.close(fig)
    for path in written:
        print(f"wrote {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
