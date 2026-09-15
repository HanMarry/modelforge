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


def composition_data():
    rng = np.random.default_rng(612)
    values = rng.gamma(2.5, 1, (6, 4))
    return values / values.sum(1, keepdims=True) * 100


from matplotlib.colors import LinearSegmentedColormap, ListedColormap, BoundaryNorm
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
    rng = np.random.default_rng(825)
    n = 22
    palette = mpl.colormaps["turbo"](np.linspace(0.06, 0.95, 22))
    theta = np.arange(n) * 2 * np.pi / n
    values = rng.dirichlet(np.ones(22), n) * rng.uniform(30, 100, (n, 1))
    fig, ax = plt.subplots(figsize=(7, 6.6), subplot_kw=dict(projection="polar"))
    fig.subplots_adjust(left=0.08, right=0.75, top=0.91, bottom=0.07)
    ax.set_theta_offset(np.pi / 2)
    ax.set_theta_direction(-1)
    base = np.full(n, 12.0)
    for j, c in enumerate(palette):
        ax.bar(
            theta,
            values[:, j],
            bottom=base,
            width=2 * np.pi / n * 0.90,
            color=c,
            edgecolor="white",
            lw=0.35,
        )
        base += values[:, j]
    for j in range(n):
        ax.text(
            theta[j],
            base[j] + 4,
            f"Object {j + 1}",
            rotation=90 - np.degrees(theta[j]),
            fontsize=5.5,
            ha="center",
            va="center",
        )
    ax.set_ylim(0, 120)
    ax.set_xticks([])
    ax.set_yticks([32, 52, 72, 92], ["20", "40", "60", "80"], fontsize=5)
    ax.grid(lw=0.4, alpha=0.4)
    ax.spines["polar"].set_visible(False)
    ax.legend(
        handles=[
            Rectangle((0, 0), 1, 1, fc=c, label=f"Component {i + 1}")
            for i, c in enumerate(palette)
        ],
        loc="upper left",
        bbox_to_anchor=(1.13, 1),
        fontsize=6,
    )
    export(fig, output_stem)


if __name__ == "__main__":
    make_figure(ROOT / "outputs" / "radial_stacked_sectors_replica")
