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
    from matplotlib.tri import Triangulation

    fig = plt.figure(figsize=(7, 5.6))
    ax = fig.add_subplot(111, projection="3d")
    u = np.linspace(0.02, 1, 14)
    v = np.linspace(0, 8, 13)
    x, y = np.meshgrid(u, v)
    z = (
        25200
        + 470 * x
        + 230 * np.sin(y)
        - 1700 * np.exp(-(((x - 0.38) / 0.15) ** 2) - ((y - 3.3) / 1.25) ** 2)
    )
    tri = Triangulation(x.ravel(), y.ravel())
    surface = ax.plot_trisurf(
        tri,
        z.ravel(),
        color="#e5d0c2",
        edgecolor="#8d716e",
        alpha=0.13,
        linewidth=0.6,
        shade=False,
    )
    cmap = LinearSegmentedColormap.from_list(
        "response", ["#98c8d2", "#463869", "#6a286e", "#b76948", "#e1c4a5"]
    )
    im = ax.tricontourf(tri, z.ravel(), zdir="z", offset=23000, levels=50, cmap=cmap)
    ax.set(
        zlim=(23000, 26300),
        xlabel="Input ratio",
        ylabel="Interaction time",
        zlabel="Response (unit)",
    )
    ax.view_init(25, -57)
    ax.set_box_aspect((1.1, 1, 0.95))
    fig.colorbar(im, ax=ax, shrink=0.60, pad=0.1, label="Response")
    export(fig, output_stem)


if __name__ == "__main__":
    make_figure(ROOT / "outputs" / "surface_projection_3d_replica")
