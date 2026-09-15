"""Metric heatmap across runs, folds or configurations (指标热力图).

A single view of "which model was best on which metric", with the best cell in each
column marked. Useful for the model-comparison section and for cross-validation tables
that would otherwise be an unreadable wall of numbers.

Run directly::

    uv run --with matplotlib python metric_heatmap.py -o out/metrics.pdf
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
    apply_style,
    draw_note,
    resolve_cjk_font,
    save_figure,
)

ZH_ROWS = ["线性回归", "岭回归", "随机森林", "XGBoost", "SVR", "神经网络"]
EN_ROWS = ["Linear", "Ridge", "Random forest", "XGBoost", "SVR", "Neural net"]

ZH_COLUMNS = ["R²", "RMSE", "MAE", "训练耗时", "预测耗时"]
EN_COLUMNS = ["R2", "RMSE", "MAE", "Train time", "Predict time"]

# Direction per column: benefit = larger is better.
COLUMN_DIRECTION = ["benefit", "cost", "cost", "cost", "cost"]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("-o", "--output", default="out/metrics.pdf")
    parser.add_argument("--seed", type=int, default=20240912)
    parser.add_argument("--lang", choices=["auto", "zh", "en"], default="auto")
    args = parser.parse_args()
    enable_utf8_stdout()

    try:
        import matplotlib.pyplot as plt
        from matplotlib.colors import LinearSegmentedColormap
    except ImportError as exc:
        print(f"matplotlib is required: {exc}", file=sys.stderr)
        return 2

    use_zh = args.lang == "zh" or (args.lang == "auto" and resolve_cjk_font() is not None)
    rows = ZH_ROWS if use_zh else EN_ROWS
    columns = ZH_COLUMNS if use_zh else EN_COLUMNS
    text = (
        {
            "title": "模型 × 指标对比",
            "note": "演示数据（合成）：每列按方向归一化，圈出该列最优",
            "best": "最优",
        }
        if use_zh
        else {
            "title": "Models by metric",
            "note": "Demo data (synthetic): columns normalised by direction, best circled",
            "best": "best",
        }
    )

    apply_style()

    rng = np.random.default_rng(args.seed)
    # Plausible raw metrics: accuracy/error columns correlated with model strength,
    # timing columns in seconds.
    strength = np.array([0.72, 0.76, 0.89, 0.93, 0.84, 0.91])
    metrics = np.column_stack(
        [
            np.clip(strength + rng.normal(0, 0.015, len(rows)), 0, 1),          # R²
            np.clip(1 - strength + rng.normal(0, 0.02, len(rows)), 0.01, None),  # RMSE
            np.clip(1.4 * (1 - strength) + rng.normal(0, 0.03, len(rows)), 0.01, None),  # MAE
            np.abs(np.array([0.4, 0.5, 6.8, 9.2, 2.6, 21.5]) + rng.normal(0, 0.3, len(rows))),
            np.abs(np.array([0.02, 0.02, 0.11, 0.09, 0.05, 0.23]) + rng.normal(0, 0.005, len(rows))),
        ]
    )

    # Normalise each column to [0, 1] with "1 = best" so one colour scale fits all.
    normalised = np.zeros_like(metrics)
    for column, direction in enumerate(COLUMN_DIRECTION):
        values = metrics[:, column]
        span = values.max() - values.min()
        scaled = (values - values.min()) / span if span > 0 else np.full_like(values, 0.5)
        normalised[:, column] = scaled if direction == "benefit" else 1 - scaled

    cmap = LinearSegmentedColormap.from_list(
        "modelforge_metric", ["#F3F5F7", "#BFD3D8", PALETTE["highlight"], PALETTE["accent"]]
    )

    fig, ax = plt.subplots(figsize=(6.6, 3.8))
    image = ax.imshow(normalised, cmap=cmap, vmin=0, vmax=1, aspect="auto")

    ax.set_xticks(np.arange(len(columns)))
    ax.set_xticklabels(columns, fontsize=8.5)
    ax.set_yticks(np.arange(len(rows)))
    ax.set_yticklabels(rows, fontsize=8.5)
    ax.grid(False)
    for spine in ax.spines.values():
        spine.set_visible(False)

    # Write the raw value in each cell and ring the best one per column.
    for row in range(len(rows)):
        for column in range(len(columns)):
            raw = metrics[row, column]
            label = f"{raw:.2f}" if abs(raw) < 100 else f"{raw:.1f}"
            ax.text(
                column,
                row,
                label,
                ha="center",
                va="center",
                fontsize=7.5,
                color="#FFFFFF" if normalised[row, column] > 0.62 else PALETTE["primary"],
            )
            if normalised[row, column] >= 1 - 1e-9:
                ax.add_patch(
                    plt.Rectangle(
                        (column - 0.5, row - 0.5),
                        1,
                        1,
                        fill=False,
                        edgecolor=PALETTE["primary"],
                        linewidth=1.8,
                    )
                )

    # Light separators so rows can be followed across.
    for boundary in np.arange(-0.5, len(rows), 1):
        ax.axhline(boundary, color="#FFFFFF", linewidth=1.2)

    ax.set_title(text["title"], fontsize=11, color=PALETTE["primary"], pad=10)
    bar = fig.colorbar(image, ax=ax, fraction=0.03, pad=0.02)
    bar.set_label("归一化得分" if use_zh else "Normalised score", fontsize=8)
    bar.ax.tick_params(labelsize=7)

    fig.tight_layout()
    draw_note(fig, text["note"])

    written = save_figure(fig, args.output)
    plt.close(fig)
    for path in written:
        print(f"wrote {path}")
    for column, name in enumerate(columns):
        best = int(np.argmax(normalised[:, column]))
        print(f"{name}: best = {rows[best]} (raw {metrics[best, column]:.3f})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
