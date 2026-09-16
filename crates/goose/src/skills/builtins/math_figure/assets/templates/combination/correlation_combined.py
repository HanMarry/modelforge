"""Correlation heatmap paired with a lower-triangle scatter matrix.

The combined layout answers "which variables move together" in one figure: the
heatmap carries the coefficient, the scatter grid carries the shape of each
relationship. Both halves share the same variable order.

Run directly::

    uv run --with matplotlib python correlation_combined.py -o out/correlation.pdf
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np  # noqa: E402

from _style import (PALETTE, apply_style, draw_note, enable_utf8_stdout, resolve_cjk_font, save_figure)  # noqa: E402

ZH_VARIABLES = ["温度", "压力", "流速", "浓度", "产量", "能耗"]
EN_VARIABLES = ["Temperature", "Pressure", "Flow", "Concentration", "Yield", "Energy"]


def correlation_matrix(data: np.ndarray) -> np.ndarray:
    """Pearson correlation matrix, computed without pandas."""
    centred = data - data.mean(axis=0, keepdims=True)
    std = centred.std(axis=0, ddof=1, keepdims=True)
    std[std == 0] = 1.0
    normalised = centred / std
    return (normalised.T @ normalised) / (data.shape[0] - 1)


def demo_data(seed: int, size: int, count: int) -> np.ndarray:
    """Latent-factor demo data so correlations are non-trivial but deterministic."""
    rng = np.random.default_rng(seed)
    latent = rng.normal(size=(size, 2))
    loadings = rng.uniform(0.4, 0.95, size=(2, count))
    noise = rng.normal(scale=0.6, size=(size, count))
    return latent @ loadings + noise


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("-o", "--output", default="out/correlation.pdf")
    parser.add_argument("-n", "--samples", type=int, default=240)
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
    text = (
        {
            "title": "相关性组合图：系数热力图与散点矩阵",
            "cbar": "相关系数 r",
            "note": "演示数据（合成）：下三角为散点，上三角为相关系数",
        }
        if use_zh
        else {
            "title": "Correlation overview: coefficient heatmap and scatter matrix",
            "cbar": "Pearson r",
            "note": "Demo data (synthetic)",
        }
    )
    variables = ZH_VARIABLES if use_zh else EN_VARIABLES

    apply_style()

    data = demo_data(args.seed, args.samples, len(variables))
    corr = correlation_matrix(data)

    # Diverging map from the brand slate to the accent orange, through white.
    cmap = LinearSegmentedColormap.from_list(
        "modelforge_diverging", [PALETTE["highlight"], "#FFFFFF", PALETTE["accent"]]
    )

    count = len(variables)
    fig, axes = plt.subplots(
        count,
        count,
        figsize=(7.2, 7.0),
        gridspec_kw={"wspace": 0.08, "hspace": 0.08},
    )

    for row in range(count):
        for column in range(count):
            ax = axes[row][column]
            ax.grid(False)
            ax.set_xticks([])
            ax.set_yticks([])

            if column > row:
                # Upper triangle: the coefficient itself.
                ax.imshow(
                    corr[row : row + 1, column : column + 1],
                    cmap=cmap,
                    vmin=-1,
                    vmax=1,
                    aspect="auto",
                    extent=(0, 1, 0, 1),
                )
                value = corr[row, column]
                ax.text(
                    0.5,
                    0.5,
                    f"{value:.2f}",
                    ha="center",
                    va="center",
                    fontsize=7.5,
                    color="#FFFFFF" if abs(value) > 0.55 else PALETTE["primary"],
                )
                for spine in ax.spines.values():
                    spine.set_visible(False)
            elif column == row:
                ax.text(
                    0.5,
                    0.5,
                    variables[row],
                    ha="center",
                    va="center",
                    fontsize=8,
                    color=PALETTE["primary"],
                )
                for spine in ax.spines.values():
                    spine.set_visible(False)
            else:
                # Lower triangle: the shape of the relationship.
                ax.scatter(
                    data[:, column],
                    data[:, row],
                    s=5,
                    color=PALETTE["primary"],
                    alpha=0.5,
                    linewidths=0,
                )
                if corr[row, column] > 0:
                    colour = PALETTE["accent"]
                else:
                    colour = PALETTE["highlight"]
                ax.tick_params(labelsize=6, colors=PALETTE["secondary"])
                if column == 0:
                    ax.set_ylabel(variables[row], fontsize=7.5)
                if row == count - 1:
                    ax.set_xlabel(variables[column], fontsize=7.5)
                ax.spines["left"].set_color(colour)
                ax.spines["bottom"].set_color(colour)

    fig.suptitle(text["title"], fontsize=11, color=PALETTE["primary"], y=0.98)

    # A shared colour bar keeps the heat cells comparable.
    scalar = plt.cm.ScalarMappable(cmap=cmap, norm=plt.Normalize(vmin=-1, vmax=1))
    bar = fig.colorbar(scalar, ax=axes, fraction=0.025, pad=0.02)
    bar.set_label(text["cbar"], fontsize=8)
    bar.ax.tick_params(labelsize=7)

    draw_note(fig, text["note"])

    written = save_figure(fig, args.output)
    plt.close(fig)

    for path in written:
        print(f"wrote {path}")
    strongest = np.unravel_index(np.argmax(np.abs(corr - np.eye(count))), corr.shape)
    print(
        f"strongest pair: {variables[strongest[0]]} ~ {variables[strongest[1]]} "
        f"r = {corr[strongest]:.3f}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
