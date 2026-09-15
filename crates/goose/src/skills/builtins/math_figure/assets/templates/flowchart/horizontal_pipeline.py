"""Horizontal task pipeline (横版任务流水线图).

A left-to-right pipeline where each stage block carries its sub-steps, used for the
"how the work was carried out" figure or a code/data-flow description. The horizontal
layout fits the top of a page better than the vertical roadmap when there are four or
fewer stages.

Run directly::

    uv run --with matplotlib python horizontal_pipeline.py -o out/pipeline.pdf
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
    ("输入", ["题目 PDF", "附件 xlsx", "历史资料"]),
    ("预处理", ["清洗与对齐", "缺失处理", "特征构造"]),
    ("建模求解", ["模型选型", "参数辨识", "数值求解"]),
    ("检验出图", ["灵敏度分析", "误差评估", "论文配图"]),
    ("论文产出", ["结构撰写", "LaTeX 编译", "附录整理"]),
]

EN_STAGES = [
    ("Input", ["Problem PDF", "Attachments", "References"]),
    ("Prepare", ["Clean and align", "Missing values", "Features"]),
    ("Model", ["Selection", "Calibration", "Solve"]),
    ("Validate", ["Sensitivity", "Error metrics", "Figures"]),
    ("Output", ["Write up", "Compile LaTeX", "Appendix"]),
]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("-o", "--output", default="out/pipeline.pdf")
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
    title = "任务流水线" if use_zh else "Task pipeline"
    note = "演示结构，替换为你的实际流程" if use_zh else "Demo structure — replace with your own"

    apply_style()
    fig, ax = diagram_axes(figsize=(8.6, 3.4))

    count = len(stages)
    margin = 0.4
    stage_width = 1.52
    gap = 0.42
    header_height = 0.42
    step_height = 0.34
    step_gap = 0.1

    steps = max(len(items) for _name, items in stages)
    body_height = steps * step_height + (steps - 1) * step_gap
    total_height = header_height + 0.18 + body_height
    top = total_height

    for index, (name, items) in enumerate(stages):
        x = margin + index * (stage_width + gap)

        # Stage header.
        block(
            ax,
            x,
            top - header_height,
            stage_width,
            header_height,
            name,
            fill=PALETTE["primary"],
            edge=PALETTE["primary"],
            text_color="#FFFFFF",
            fontsize=8.4,
        )

        # Sub-steps stacked underneath.
        for step_index, item in enumerate(items):
            y = top - header_height - 0.18 - (step_index + 1) * step_height - step_index * step_gap
            block(
                ax,
                x + 0.06,
                y,
                stage_width - 0.12,
                step_height,
                item,
                fill=BLOCK_FILL_ACCENT if index in (1, 3) else BLOCK_FILL,
                edge=PALETTE["tertiary"],
                fontsize=6.6,
                radius=0.05,
            )

        # Hand-off arrow to the next stage.
        if index < count - 1:
            arrow(
                ax,
                (x + stage_width, top - header_height / 2),
                (x + stage_width + gap, top - header_height / 2),
                color=PALETTE["accent"],
            )
            ax.text(
                x + stage_width + gap / 2,
                top - header_height / 2 + 0.1,
                "→" if use_zh else "",
                ha="center",
                va="bottom",
                fontsize=7,
                color=PALETTE["accent"],
            )

    ax.set_xlim(0, margin * 2 + count * stage_width + (count - 1) * gap)
    ax.set_ylim(-0.4, top + 0.5)
    title_and_note(ax, title, note)

    fig.tight_layout()
    written = save_figure(fig, args.output)
    plt.close(fig)
    for path in written:
        print(f"wrote {path}")
    print(f"{count} stages, up to {steps} steps each")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
