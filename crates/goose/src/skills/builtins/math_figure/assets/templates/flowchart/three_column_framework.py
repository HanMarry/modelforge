"""Three-column research framework diagram (三栏研究框架图).

The "what we did" page of a modeling paper in one figure: a left column of stages,
a middle column of research content, and a right column of the concrete methods and
models used at that stage.

Run directly::

    uv run --with matplotlib python three_column_framework.py -o out/framework.pdf
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

ZH_CONTENT = [
    {
        "stage": "问题分析",
        "research": ["赛题条件梳理", "目标与约束识别", "数据可用性核查"],
        "methods": ["文献调研", "描述性统计", "相关性分析"],
    },
    {
        "stage": "模型构建",
        "research": ["决策变量与目标函数", "约束条件形式化", "参数辨识方案"],
        "methods": ["线性/整数规划", "微分方程建模", "回归与分类"],
    },
    {
        "stage": "求解算法",
        "research": ["算法选型与实现", "收敛性与稳定性", "计算复杂度评估"],
        "methods": ["启发式搜索", "梯度类方法", "数值积分"],
    },
    {
        "stage": "检验与评价",
        "research": ["灵敏度分析", "误差与残差诊断", "与基线方法对比"],
        "methods": ["蒙特卡洛模拟", "交叉验证", "多指标评价"],
    },
]

EN_CONTENT = [
    {
        "stage": "Problem analysis",
        "research": ["Conditions and targets", "Objectives and constraints", "Data availability"],
        "methods": ["Literature review", "Descriptives", "Correlation analysis"],
    },
    {
        "stage": "Model building",
        "research": ["Decision variables", "Constraint formulation", "Calibration plan"],
        "methods": ["LP / MILP", "Differential equations", "Regression, classification"],
    },
    {
        "stage": "Solution algorithm",
        "research": ["Algorithm selection", "Convergence and stability", "Complexity estimate"],
        "methods": ["Metaheuristics", "Gradient methods", "Numerical integration"],
    },
    {
        "stage": "Validation",
        "research": ["Sensitivity analysis", "Residual diagnostics", "Baseline comparison"],
        "methods": ["Monte Carlo", "Cross-validation", "Multi-criteria scoring"],
    },
]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("-o", "--output", default="out/framework.pdf")
    parser.add_argument("--lang", choices=["auto", "zh", "en"], default="auto")
    args = parser.parse_args()
    enable_utf8_stdout()

    try:
        import matplotlib.pyplot as plt
    except ImportError as exc:
        print(f"matplotlib is required: {exc}", file=sys.stderr)
        return 2

    use_zh = args.lang == "zh" or (args.lang == "auto" and resolve_cjk_font() is not None)
    blocks = ZH_CONTENT if use_zh else EN_CONTENT
    headings = (
        ("阶段", "研究内容", "方法与模型") if use_zh else ("Stage", "Research content", "Methods and models")
    )
    title = "三栏研究框架图" if use_zh else "Research framework"
    note = "演示结构，替换为你的实际研究内容" if use_zh else "Demo structure — replace with your own content"

    apply_style()
    fig, ax = diagram_axes(figsize=(7.6, 4.9))

    margin = 0.4
    stage_width = 1.35
    gap = 0.34
    total_width = 7.3
    remaining = total_width - stage_width - 2 * gap
    research_width = remaining * 0.44
    methods_width = remaining - research_width

    stage_x = margin
    research_x = stage_x + stage_width + gap
    methods_x = research_x + research_width + gap

    row_height = 0.82
    row_gap = 0.3
    top = len(blocks) * row_height + (len(blocks) - 1) * row_gap
    header_height = 0.36

    # Column headers.
    for x, width, text in (
        (stage_x, stage_width, headings[0]),
        (research_x, research_width, headings[1]),
        (methods_x, methods_width, headings[2]),
    ):
        block(
            ax,
            x,
            top + 0.12,
            width,
            header_height,
            text,
            fill="#FFFFFF",
            edge=PALETTE["tertiary"],
            text_color=PALETTE["secondary"],
            fontsize=7.6,
        )

    for index, entry in enumerate(blocks):
        y = top - (index + 1) * row_height - index * row_gap

        block(
            ax,
            stage_x,
            y,
            stage_width,
            row_height,
            entry["stage"],
            fill=PALETTE["primary"],
            edge=PALETTE["primary"],
            text_color="#FFFFFF",
            fontsize=8.0,
        )

        block(
            ax,
            research_x,
            y,
            research_width,
            row_height,
            "\n".join(entry["research"]),
            fill=BLOCK_FILL_ACCENT,
            edge=PALETTE["tertiary"],
            fontsize=6.9,
        )

        block(
            ax,
            methods_x,
            y,
            methods_width,
            row_height,
            "\n".join(entry["methods"]),
            fill=BLOCK_FILL,
            edge=PALETTE["tertiary"],
            fontsize=6.9,
        )

        # Stage → research → methods, so the reading order is explicit.
        arrow(
            ax,
            (stage_x + stage_width, y + row_height / 2),
            (research_x, y + row_height / 2),
        )
        arrow(
            ax,
            (research_x + research_width, y + row_height / 2),
            (methods_x, y + row_height / 2),
        )

        if index < len(blocks) - 1:
            arrow(ax, (stage_x + stage_width / 2, y), (stage_x + stage_width / 2, y - row_gap))

    ax.set_xlim(0, total_width + margin)
    ax.set_ylim(top - len(blocks) * row_height - (len(blocks) - 1) * row_gap - 0.3, top + 0.65)
    title_and_note(ax, title, note)

    fig.tight_layout()
    written = save_figure(fig, args.output)
    plt.close(fig)
    for path in written:
        print(f"wrote {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())