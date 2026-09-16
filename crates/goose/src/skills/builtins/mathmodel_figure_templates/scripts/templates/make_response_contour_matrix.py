from __future__ import annotations
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("MPLCONFIGDIR", str(ROOT / ".mplconfig"))
import matplotlib as mpl

mpl.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from scipy import stats
from matplotlib.colors import (
    Normalize,
    LinearSegmentedColormap,
    ListedColormap,
    BoundaryNorm,
)
from matplotlib.patches import Circle, Ellipse, Polygon, Wedge, Rectangle, PathPatch
from matplotlib.path import Path as MplPath
from matplotlib.lines import Line2D
from matplotlib import cm

COLORS = ["#21615b", "#78b6ad", "#dfa09e", "#a92d32", "#d9be82", "#847092"]

from scipy import stats
from matplotlib.colors import (
    Normalize,
    LinearSegmentedColormap,
    ListedColormap,
    BoundaryNorm,
)
from matplotlib.patches import Rectangle, PathPatch
from matplotlib.path import Path as MplPath
from matplotlib.lines import Line2D
from matplotlib import cm


def configure():
    mpl.rcParams.update(
        {
            "font.family": "DejaVu Serif",
            "font.size": 8,
            "axes.titlesize": 9,
            "axes.labelsize": 8,
            "legend.fontsize": 7,
            "xtick.labelsize": 7,
            "ytick.labelsize": 7,
            "axes.linewidth": 0.65,
            "lines.linewidth": 1.0,
            "xtick.major.width": 0.6,
            "ytick.major.width": 0.6,
            "axes.spines.top": True,
            "axes.spines.right": True,
            "axes.prop_cycle": mpl.cycler(color=COLORS),
            "legend.frameon": False,
            "pdf.fonttype": 42,
            "svg.fonttype": "none",
        }
    )


def export(fig, output_stem):
    output_stem = Path(output_stem)
    output_stem.parent.mkdir(parents=True, exist_ok=True)
    fig.text(
        0.5,
        0.006,
        "Illustrative data",
        ha="center",
        va="bottom",
        fontsize=5,
        color=".55",
    )
    for ext in (".png", ".pdf", ".svg"):
        fig.savefig(
            output_stem.with_suffix(ext),
            dpi=300,
            bbox_inches="tight",
            pad_inches=0.06,
            facecolor="white",
        )
    plt.close(fig)


def make_figure(output_stem):
    configure()
    grid = np.linspace(-2.5, 2.5, 55)
    x, y = np.meshgrid(grid, grid)
    fig, axes = plt.subplots(2, 3, figsize=(10.8, 6.4))
    fig.subplots_adjust(
        left=0.08, right=0.94, top=0.91, bottom=0.13, wspace=0.32, hspace=0.34
    )
    cmap = LinearSegmentedColormap.from_list(
        "cyanviolet", ["#55bfc1", "#469bc5", "#6c29bb"]
    )
    pairs = [(1, 2), (1, 3), (1, 4), (2, 3), (2, 4), (3, 4)]
    for k, ax in enumerate(axes.flat):
        z = [
            lambda x, y: 0.6 - 0.18 * x * x + 0.08 * y,
            lambda x, y: 0.42 * x,
            lambda x, y: 0.40 * x + 0.01 * y,
            lambda x, y: -0.42 * x + 0.06 * y,
            lambda x, y: -0.35 * x + 0.04 * y,
            lambda x, y: 0.18 * x - 0.23 * y,
        ][k](x, y)
        levels = np.linspace(-1, 1, 14)
        im = ax.contourf(x, y, z, levels=levels, cmap=cmap)
        lines = ax.contour(
            x, y, z, levels=levels[::2], colors="white", linewidths=0.5, alpha=0.8
        )
        ax.clabel(lines, fontsize=4, fmt="%.1f")
        ax.set_xlabel(f"Feature {pairs[k][0]}")
        ax.set_ylabel(f"Feature {pairs[k][1]}")
        ax.set_title(
            f"Partial dependence of {pairs[k][0]} and {pairs[k][1]}", fontsize=7
        )
        ax.tick_params(labelsize=6)
        fig.colorbar(im, ax=ax, fraction=0.045, pad=0.02).ax.tick_params(labelsize=5)
    export(fig, output_stem)


if __name__ == "__main__":
    make_figure(ROOT / "outputs" / "response_contour_matrix_replica")
