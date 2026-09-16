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
from matplotlib.colors import Normalize
from matplotlib.patches import Circle, Ellipse, Polygon, Wedge

COLORS = ["#287C8E", "#D58B52", "#7774A6", "#668D62", "#C36779", "#A99B59"]


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
    rng = np.random.default_rng(891)
    fig, ax = plt.subplots(figsize=(7, 6))
    fig.subplots_adjust(left=0.15, right=0.72, bottom=0.15, top=0.90)
    palette = ["#eaa181", "#8bbbd0", "#167daf"]
    values = np.r_[
        rng.uniform(0.25, 0.7, 3), rng.uniform(0.02, 0.25, 3), rng.uniform(0.1, 0.45, 3)
    ]
    for group in range(3):
        ax.axhspan(
            group * 3 - 0.5,
            group * 3 + 2.5,
            color=["#fbefe7", "#eef6fa", "#dceaf4"][group],
            lw=0,
        )
        ax.text(0.76, group * 3 + 1, f"Model {group + 1}", fontsize=8, va="center")
    for i, v in enumerate(values):
        ax.hlines(i, 0, v, color=palette[i // 3], lw=1.2, ls=":")
        ax.scatter(v, i, s=28 + 90 * v, c=palette[i // 3], ec="white", lw=0.45)
    ax.set_yticks(range(9), ["TV", "NDV", "SV"] * 3, fontsize=7)
    ax.set(
        xlim=(0, 0.8),
        ylim=(8.5, -0.5),
        xlabel="Coefficient value",
        ylabel="Standardized coefficients",
    )
    ax.spines[["top", "right"]].set_visible(False)
    ax.legend(
        handles=[
            Line2D([], [], c=c, marker="o", ms=5, label=l)
            for c, l in zip(palette, ["Pleasure", "Safety", "Comfort"])
        ],
        loc="center left",
        bbox_to_anchor=(1.1, 0.35),
        fontsize=7,
    )
    export(fig, output_stem)


if __name__ == "__main__":
    make_figure(ROOT / "outputs" / "lollipop_effect_grid_replica")
