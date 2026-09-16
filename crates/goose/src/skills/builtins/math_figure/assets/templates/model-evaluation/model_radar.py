"""Multi-model comparison radar (多模型雷达图).

Compares several candidate models across normalised metrics. Each metric is scaled to
[0, 1] with a stated direction first, so a radar plot is actually readable — raw values
in different units on one radar are misleading.

Run directly::

    uv run --with matplotlib python model_radar.py -o out/radar.pdf
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np  # noqa: E402

from _style import (  # noqa: E402
    PALETTE,
    enable_utf8_stdout,
    SERIES,
    apply_style,
    draw_note,
    resolve_cjk_font,
    save_figure,
)

ZH_METRICS = [
    ("拟合精度", "benefit"),
    ("泛化能力", "benefit"),
    ("计算速度", "benefit"),
    ("可解释性", "benefit"),
    ("稳健性", "benefit"),
    ("数据需求", "cost"),
]
EN_METRICS = [
    ("Fit accuracy", "benefit"),
    ("Generalisation", "benefit"),
    ("Speed", "benefit"),
    ("Interpretability", "benefit"),
    ("Robustness", "benefit"),
    ("Data demand", "cost"),
]

ZH_MODELS = ["线性回归", "随机森林", "XGBoost", "神经网络"]
EN_MODELS = ["Linear", "Random forest", "XGBoost", "Neural net"]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("-o", "--output", default="out/radar.pdf")
    parser.add_argument("--lang", choices=["auto", "zh", "en"], default="auto")
    args = parser.parse_args()
    enable_utf8_stdout()

    try:
        import matplotlib.pyplot as plt
    except ImportError as exc:
        print(f"matplotlib is required: {exc}", file=sys.stderr)
        return 2

    use_zh = args.lang == "zh" or (args.lang == "auto" and resolve_cjk_font() is not None)
    metrics = ZH_METRICS if use_zh else EN_METRICS
    models = ZH_MODELS if use_zh else EN_MODELS
    text = (
        {
            "title": "多模型综合对比",
            "note": "演示数据（合成）：各指标已按方向归一化到 0–1，替换为你的实测值",
            "axis": "归一化得分",
        }
        if use_zh
        else {
            "title": "Model comparison across metrics",
            "note": "Demo data (synthetic): metrics normalised to 0-1 by direction",
            "axis": "Normalised score",
        }
    )

    apply_style()

    # Raw scores per model per metric, in the metric's own units.
    raw = np.array(
        [
            [0.86, 0.71, 0.95, 0.92, 0.68, 0.90],  # linear regression
            [0.93, 0.89, 0.62, 0.55, 0.84, 0.60],  # random forest
            [0.96, 0.93, 0.55, 0.42, 0.88, 0.52],  # xgboost
            [0.97, 0.90, 0.34, 0.28, 0.72, 0.20],  # neural net
        ]
    )

    # Normalise each metric column to [0, 1], flipping cost-type metrics so that a
    # larger radius always means "better".
    normalised = np.zeros_like(raw)
    for column, (_name, direction) in enumerate(metrics):
        values = raw[:, column]
        span = values.max() - values.min()
        scaled = (values - values.min()) / span if span > 0 else np.full_like(values, 0.5)
        normalised[:, column] = scaled if direction == "benefit" else 1 - scaled

    angles = np.linspace(0, 2 * np.pi, len(metrics), endpoint=False)
    closed_angles = np.concatenate([angles, angles[:1]])

    fig, ax = plt.subplots(figsize=(5.6, 5.0), subplot_kw={"projection": "polar"})

    for index, model in enumerate(models):
        values = np.concatenate([normalised[index], normalised[index][:1]])
        ax.plot(closed_angles, values, color=SERIES[index % len(SERIES)], linewidth=1.8, label=model)
        ax.fill(closed_angles, values, color=SERIES[index % len(SERIES)], alpha=0.08)

    ax.set_theta_offset(np.pi / 2)
    ax.set_theta_direction(-1)
    ax.set_xticks(angles)
    ax.set_xticklabels(
        [f"{name}\n({'↓' if direction == 'cost' else '↑'})" for name, direction in metrics],
        fontsize=8,
    )
    ax.set_ylim(0, 1)
    ax.set_yticks([0.25, 0.5, 0.75, 1.0])
    ax.set_yticklabels(["0.25", "0.50", "0.75", "1.00"], fontsize=6.5, color=PALETTE["secondary"])
    ax.set_rlabel_position(200)
    ax.tick_params(pad=6)
    ax.grid(color=PALETTE["grid"], linewidth=0.6)
    ax.spines["polar"].set_color(PALETTE["tertiary"])
    ax.set_title(text["title"], fontsize=11, color=PALETTE["primary"], pad=18)
    ax.legend(loc="upper right", bbox_to_anchor=(1.28, 1.12), fontsize=8)

    fig.tight_layout()
    draw_note(fig, text["note"])

    written = save_figure(fig, args.output)
    plt.close(fig)
    for path in written:
        print(f"wrote {path}")
    for index, model in enumerate(models):
        print(f"{model}: mean normalised score = {normalised[index].mean():.3f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
