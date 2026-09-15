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
    rng = np.random.default_rng(928)
    fig = plt.figure(figsize=(6.8, 6.2))
    ax = fig.add_subplot(111, projection="3d")
    xx, yy = np.meshgrid(np.arange(9), np.arange(8))
    cmap = mpl.colormaps["hot_r"]
    norm = Normalize(0, 1)
    for k in range(4):
        value = rng.uniform(0, 1, (7, 8))
        face = cmap(value)
        face = np.pad(face, ((0, 1), (0, 1), (0, 0)), mode="edge")
        ax.plot_surface(
            xx,
            yy,
            np.full(xx.shape, k),
            facecolors=face,
            rstride=1,
            cstride=1,
            shade=False,
            linewidth=0,
            antialiased=False,
        )
    ax.set(
        xlim=(0, 8),
        ylim=(0, 7),
        zlim=(-0.1, 3.2),
        xlabel="X trait",
        ylabel="Y trait",
        zlabel="Layer",
    )
    ax.set_zticks(range(4))
    ax.view_init(20, -58)
    ax.set_box_aspect((1.2, 1.2, 1.4))
    fig.colorbar(
        mpl.cm.ScalarMappable(norm=norm, cmap=cmap),
        ax=ax,
        shrink=0.60,
        pad=0.1,
        label="Value",
    )
    export(fig, output_stem)


if __name__ == "__main__":
    make_figure(ROOT / "outputs" / "layered_heatmaps_3d_replica")
