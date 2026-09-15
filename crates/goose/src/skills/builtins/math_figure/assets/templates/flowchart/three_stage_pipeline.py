"""Three-stage problem-driven roadmap (三阶段问题驱动路线图).

For problems that are solved in three passes — describe the data, predict with a
model, then explore scenarios — this lays the three stages out left to right and
lists what each stage consumes and produces, with the data hand-off made explicit.

Run directly::

    uv run --with matplotlib python three_stage_pipeline.py -o out/pipeline.pdf
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
    {
        "name": "阶段一：数据刻画",
        "inputs": ["赛题附件", "历史统计"],
        "steps": ["清洗与对齐", "分布与趋势", "指标构建"],
        "outputs": ["特征表", "描述性指标"],
        "method": "统计描述 · 相关性",
    },
    {
        "name": "阶段二：模型预测",
        "inputs": ["特征表", "目标变量"],
        "steps": ["模型选型", "参数辨识", "精度验证"],
        "outputs": ["预测模型", "误差指标"],
        "method": "回归 · 分类 · 集成",
    },
    {
        "name": "阶段三：情景路径",
        "inputs": ["预测模型", "情景假设"],
        "steps": ["情景设定", "敏感性扫描", "方案比较"],
        "outputs": ["情景路径", "决策建议"],
        "method": "模拟 · 优化 · 评价",
    },
]

EN_STAGES = [
    {
        "name": "Stage 1: describe the data",
        "inputs": ["Attachments", "Historical records"],
        "steps": ["Clean and align", "Distribution and trend", "Feature construction"],
        "outputs": ["Feature table", "Descriptive metrics"],
        "method": "Descriptives · correlation",
    },
    {
        "name": "Stage 2: model and predict",
        "inputs": ["Feature table", "Target variable"],
        "steps": ["Model selection", "Calibration", "Accuracy check"],
        "outputs": ["Predictive model", "Error metrics"],
        "method": "Regression · classification",
    },
    {
        "name": "Stage 3: scenario paths",
        "inputs": ["Predictive model", "Assumptions"],
        "steps": ["Scenario setup", "Sensitivity sweep", "Option comparison"],
        "outputs": ["Scenario paths", "Recommendations"],
        "method": "Simulation · optimisation",
    },
]

LABELS_ZH = {"inputs": "输入", "steps": "处理", "outputs": "输出"}
LABELS_EN = {"inputs": "Inputs", "steps": "Processing", "outputs": "Outputs"}


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
    labels = LABELS_ZH if use_zh else LABELS_EN
    title = "三阶段问题驱动路线图" if use_zh else "Three-stage problem-driven roadmap"
    note = "演示结构，替换为你的实际流程" if use_zh else "Demo structure — replace with your own pipeline"

    apply_style()
    fig, ax = diagram_axes(figsize=(7.8, 4.6))

    margin = 0.4
    column_width = 2.1
    gap = 0.55
    header_height = 0.42
    lane_height = 0.62
    lane_gap = 0.16
    footer_height = 0.34

    lane_titles = [labels["inputs"], labels["steps"], labels["outputs"]]
    content_height = len(lane_titles) * lane_height + (len(lane_titles) - 1) * lane_gap
    total_height = header_height + 0.2 + content_height + 0.34 + footer_height

    for index, stage in enumerate(stages):
        x = margin + index * (column_width + gap)
        top = total_height

        block(
            ax,
            x,
            top - header_height,
            column_width,
            header_height,
            stage["name"],
            fill=PALETTE["primary"],
            edge=PALETTE["primary"],
            text_color="#FFFFFF",
            fontsize=8.2,
        )

        lane_top = top - header_height - 0.2
        for lane_index, (key, lane_title) in enumerate(
            zip(("inputs", "steps", "outputs"), lane_titles)
        ):
            y = lane_top - (lane_index + 1) * lane_height - lane_index * lane_gap

            block(
                ax,
                x,
                y,
                column_width,
                lane_height,
                "\n".join(stage[key]),
                fill=BLOCK_FILL_ACCENT if key == "outputs" else BLOCK_FILL,
                edge=PALETTE["tertiary"],
                fontsize=6.8,
            )
            # Lane label sits in the left gutter of the first column only, so the
            # three stages read across as three rows.
            if index == 0:
                ax.text(
                    x - 0.08,
                    y + lane_height / 2,
                    lane_title,
                    ha="right",
                    va="center",
                    fontsize=6.8,
                    color=PALETTE["secondary"],
                )

            if lane_index < len(lane_titles) - 1:
                arrow(
                    ax,
                    (x + column_width / 2, y),
                    (x + column_width / 2, y - lane_gap),
                    color=PALETTE["tertiary"],
                )

        # Hand-off arrow between stages.
        if index < len(stages) - 1:
            arrow(
                ax,
                (x + column_width, top - header_height / 2),
                (x + column_width + gap, top - header_height / 2),
                color=PALETTE["accent"],
            )

        block(
            ax,
            x,
            top - total_height,
            column_width,
            footer_height,
            stage["method"],
            fill="#FFFFFF",
            edge=PALETTE["tertiary"],
            text_color=PALETTE["secondary"],
            fontsize=6.8,
        )

    ax.set_xlim(0, margin * 2 + len(stages) * column_width + (len(stages) - 1) * gap + 0.55)
    ax.set_ylim(-0.35, total_height + 0.5)
    title_and_note(ax, title, note)

    fig.tight_layout()
    written = save_figure(fig, args.output)
    plt.close(fig)
    for path in written:
        print(f"wrote {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())