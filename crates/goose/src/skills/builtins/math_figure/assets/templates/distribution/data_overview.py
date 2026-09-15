"""Data overview panel for the paper's data section (数据体检多面板图).

Four panels that answer the questions a reviewer asks about your data before believing
any model: how much is missing, how are the variables distributed, which pairs are
correlated, and what does the time index look like.

Run directly::

    uv run --with matplotlib python data_overview.py -o out/overview.pdf
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np  # noqa: E402

from _style import (  # noqa: E402
    PALETTE,
    SERIES,
    apply_style,
    draw_note,
    enable_utf8_stdout,
    resolve_cjk_font,
    save_figure,
)

ZH_COLUMNS = ["温度", "压力", "流速", "浓度", "产量", "能耗"]
EN_COLUMNS = ["Temperature", "Pressure", "Flow", "Concentration", "Yield", "Energy"]


def demo_frame(seed: int, samples: int, columns: int) -> tuple[np.ndarray, np.ndarray]:
    """Synthetic frame with a latent factor, missing values and a non-normal column.

    Deliberately imperfect: a clean dataset would make the overview panel pointless.
    """
    rng = np.random.default_rng(seed)
    latent = rng.normal(size=samples)
    data = np.empty((samples, columns))
    for index in range(columns):
        loading = rng.uniform(0.4, 0.9)
        noise = rng.normal(scale=rng.uniform(0.4, 0.9), size=samples)
        data[:, index] = loading * latent + noise
    # Make the last column right-skewed, as real count/energy data usually is.
    data[:, -1] = np.abs(data[:, -1]) ** 2

    missing = rng.random(data.shape) < rng.uniform(0.01, 0.06, size=columns)
    return data, missing


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("-o", "--output", default="out/overview.pdf")
    parser.add_argument("-n", "--samples", type=int, default=240)
    parser.add_argument("--seed", type=int, default=20240912)
    parser.add_argument("--lang", choices=["auto", "zh", "en"], default="auto")
    args = parser.parse_args()
    enable_utf8_stdout()

    try:
        import matplotlib.pyplot as plt
    except ImportError as exc:
        print(f"matplotlib is required: {exc}", file=sys.stderr)
        return 2

    use_zh = args.lang == "zh" or (args.lang == "auto" and resolve_cjk_font() is not None)
    columns = ZH_COLUMNS if use_zh else EN_COLUMNS
    text = (
        {
            "title": "数据体检概览",
            "missing": "缺失率（%）",
            "box": "各变量分布",
            "corr": "变量相关性",
            "trend": "随时间变化",
            "time": "时间序号",
            "note": "演示数据（合成）：刻意含缺失与非正态列，替换为你的真实数据",
        }
        if use_zh
        else {
            "title": "Data overview",
            "missing": "Missing rate (%)",
            "box": "Variable distributions",
            "corr": "Correlation",
            "trend": "Over time",
            "time": "Time index",
            "note": "Demo data (synthetic): includes missing values and a skewed column",
        }
    )

    apply_style()
    data, missing = demo_frame(args.seed, args.samples, len(columns))
    rate = missing.mean(axis=0) * 100

    fig, axes = plt.subplots(2, 2, figsize=(8.4, 6.0))

    # --- Missing rate -------------------------------------------------------
    ax = axes[0][0]
    positions = np.arange(len(columns))
    bars = ax.barh(positions, rate, color=PALETTE["accent"], height=0.6)
    ax.set_yticks(positions)
    ax.set_yticklabels(columns, fontsize=8)
    ax.invert_yaxis()
    ax.set_xlabel(text["missing"])
    ax.grid(axis="y", visible=False)
    for bar, value in zip(bars, rate):
        ax.text(
            bar.get_width() + max(rate.max() * 0.02, 0.05),
            bar.get_y() + bar.get_height() / 2,
            f"{value:.1f}",
            va="center",
            fontsize=7,
            color=PALETTE["secondary"],
        )
    ax.set_xlim(0, max(rate.max() * 1.25, 1.0))

    # --- Distributions ------------------------------------------------------
    ax = axes[0][1]
    # Standardise so six differently-scaled variables fit on one axis; the point is
    # shape and spread, not level.
    standardised = (data - np.nanmean(data, axis=0)) / np.nanstd(data, axis=0)
    box = ax.boxplot(
        [standardised[:, index] for index in range(len(columns))],
        tick_labels=columns,
        patch_artist=True,
        widths=0.55,
        medianprops={"color": PALETTE["primary"], "linewidth": 1.6},
        flierprops={"marker": ".", "markersize": 3, "markerfacecolor": PALETTE["secondary"]},
    )
    for patch in box["boxes"]:
        patch.set_facecolor("#FFFFFF")
        patch.set_edgecolor(PALETTE["secondary"])
    ax.set_title(text["box"], fontsize=9)
    ax.tick_params(axis="x", labelsize=7.5, rotation=20)
    ax.axhline(0, color=PALETTE["tertiary"], linewidth=0.8, linestyle="--")

    # --- Correlation --------------------------------------------------------
    ax = axes[1][0]
    filled = np.where(missing, np.nan, data)
    corr = np.ma.corrcoef(np.ma.masked_invalid(filled), rowvar=False)
    image = ax.imshow(corr, cmap="RdBu_r", vmin=-1, vmax=1)
    ax.set_xticks(np.arange(len(columns)))
    ax.set_xticklabels(columns, fontsize=7, rotation=45, ha="right")
    ax.set_yticks(np.arange(len(columns)))
    ax.set_yticklabels(columns, fontsize=7)
    ax.grid(False)
    for row in range(len(columns)):
        for column in range(len(columns)):
            value = float(corr[row, column])
            ax.text(
                column,
                row,
                f"{value:.2f}",
                ha="center",
                va="center",
                fontsize=6.2,
                color="#FFFFFF" if abs(value) > 0.6 else PALETTE["primary"],
            )
    ax.set_title(text["corr"], fontsize=9)

    # --- Time index ---------------------------------------------------------
    ax = axes[1][1]
    for index in range(min(3, len(columns))):
        series = filled[:, index]
        ax.plot(series, color=SERIES[index % len(SERIES)], linewidth=1.1, label=columns[index])
    ax.set_xlabel(text["time"])
    ax.set_title(text["trend"], fontsize=9)
    ax.legend(fontsize=7, loc="upper left")
    # A gap is itself information: mark where readings are missing.
    gap_rows = np.flatnonzero(missing[:, 0])
    for row in gap_rows:
        ax.axvline(row, color=PALETTE["accent"], alpha=0.45, linewidth=1.6, zorder=0)
    if gap_rows.size:
        ax.text(
            0.99,
            0.02,
            ("缺口 = 缺失" if use_zh else "gaps = missing"),
            transform=ax.transAxes,
            ha="right",
            fontsize=6.5,
            color=PALETTE["secondary"],
        )

    fig.suptitle(text["title"], fontsize=11.5, color=PALETTE["primary"])
    fig.tight_layout(rect=(0, 0.015, 1, 0.97))
    draw_note(fig, text["note"])

    written = save_figure(fig, args.output)
    plt.close(fig)
    for path in written:
        print(f"wrote {path}")
    print("missing rate by column: " + ", ".join(f"{c}={r:.2f}%" for c, r in zip(columns, rate)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
