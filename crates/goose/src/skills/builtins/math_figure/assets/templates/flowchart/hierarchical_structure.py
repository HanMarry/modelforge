"""Hierarchical problem-decomposition diagram (层次结构图).

A three-level tree: the problem at the top, the sub-questions in the middle, and the
data / method each sub-question needs at the bottom. This is the figure that shows a
reader you understood the problem before you started modelling.

Run directly::

    uv run --with matplotlib python hierarchical_structure.py -o out/hierarchy.pdf
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

ZH_TREE = {
    "root": "赛题总目标",
    "questions": [
        {"name": "问题一：现状刻画", "children": ["附件数据清洗", "描述性统计", "相关性分析"]},
        {"name": "问题二：建模与求解", "children": ["模型选择与假设", "算法实现", "结果验证"]},
        {"name": "问题三：情景与决策", "children": ["情景设定", "灵敏度扫描", "方案比选"]},
    ],
}

EN_TREE = {
    "root": "Overall objective",
    "questions": [
        {"name": "Q1: describe", "children": ["Clean attachments", "Descriptives", "Correlation"]},
        {"name": "Q2: model", "children": ["Model and assumptions", "Implementation", "Validation"]},
        {"name": "Q3: decide", "children": ["Scenario setup", "Sensitivity sweep", "Comparison"]},
    ],
}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("-o", "--output", default="out/hierarchy.pdf")
    parser.add_argument("--lang", choices=["auto", "zh", "en"], default="auto")
    args = parser.parse_args()
    enable_utf8_stdout()

    try:
        import matplotlib.pyplot as plt
    except ImportError as exc:
        print(f"matplotlib is required: {exc}", file=sys.stderr)
        return 2

    use_zh = args.lang == "zh" or (args.lang == "auto" and resolve_cjk_font() is not None)
    tree = ZH_TREE if use_zh else EN_TREE
    title = "问题分解层次结构" if use_zh else "Problem decomposition"
    note = "演示结构，替换为你的实际拆解" if use_zh else "Demo structure — replace with your own"

    apply_style()
    fig, ax = diagram_axes(figsize=(8.0, 5.0))

    questions = tree["questions"]
    count = len(questions)

    root_width = 2.6
    root_height = 0.62
    leaf_width = 1.85
    leaf_height = 0.72
    column_gap = 0.5
    level_gap = 0.95

    total_width = count * leaf_width + (count - 1) * column_gap
    margin = 0.45
    top = 3.3

    # Root, centred over the whole tree.
    root_x = margin + total_width / 2 - root_width / 2
    block(
        ax,
        root_x,
        top,
        root_width,
        root_height,
        tree["root"],
        fill=PALETTE["primary"],
        edge=PALETTE["primary"],
        text_color="#FFFFFF",
        fontsize=9,
        radius=0.14,
    )

    question_y = top - level_gap
    leaf_y = question_y - level_gap

    for index, question in enumerate(questions):
        column_x = margin + index * (leaf_width + column_gap)
        centre_x = column_x + leaf_width / 2

        # Sub-question node.
        block(
            ax,
            column_x,
            question_y,
            leaf_width,
            root_height,
            question["name"],
            fill=BLOCK_FILL_ACCENT,
            edge=PALETTE["secondary"],
            fontsize=8,
        )

        # Elbow arrow: down from the root rail, then across into the node.
        root_bottom = top
        rail_x = root_x + root_width / 2
        arrow(ax, (rail_x, root_bottom), (rail_x, question_y + root_height + 0.14), color=PALETTE["tertiary"])
        arrow(
            ax,
            (rail_x, question_y + root_height + 0.14),
            (centre_x, question_y + root_height + 0.14),
            color=PALETTE["tertiary"],
        )
        arrow(
            ax,
            (centre_x, question_y + root_height + 0.14),
            (centre_x, question_y + root_height),
            color=PALETTE["tertiary"],
        )

        # Leaf nodes for this sub-question, laid out symmetrically about the centre
        # so the group reads as belonging to the node above it.
        children = question["children"]
        leaf_gap = 0.07
        leaf_w = (leaf_width - (len(children) - 1) * leaf_gap) / len(children)
        group_width = len(children) * leaf_w + (len(children) - 1) * leaf_gap
        group_left = centre_x - group_width / 2

        for leaf_index, leaf in enumerate(children):
            leaf_x = group_left + leaf_index * (leaf_w + leaf_gap)
            block(
                ax,
                leaf_x,
                leaf_y,
                leaf_w,
                leaf_height,
                leaf,
                fill=BLOCK_FILL,
                edge=PALETTE["tertiary"],
                fontsize=6.6,
                radius=0.06,
            )
            arrow(
                ax,
                (centre_x, question_y),
                (leaf_x + leaf_w / 2, leaf_y + leaf_height),
                color=PALETTE["tertiary"],
                style="-",
            )

    ax.set_xlim(0, margin * 2 + total_width)
    ax.set_ylim(leaf_y - 0.35, top + root_height + 0.45)
    title_and_note(ax, title, note)

    fig.tight_layout()
    written = save_figure(fig, args.output)
    plt.close(fig)
    for path in written:
        print(f"wrote {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
