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


from mpl_toolkits.mplot3d.art3d import Poly3DCollection


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
    from mpl_toolkits.mplot3d.art3d import Poly3DCollection

    rng = np.random.default_rng(787)
    fig = plt.figure(figsize=(7.4, 5.8))
    ax = fig.add_subplot(111, projection="3d")
    t = np.arange(2005, 2023, 2)
    palette = LinearSegmentedColormap.from_list(
        "regions", ["#074d59", "#4c9992", "#d4d998", "#e9b85b", "#dc7132", "#a32126"]
    )(np.linspace(0, 1, 8))
    for j, c in enumerate(palette):
        z = (
            0.08
            + j * 0.055
            + 0.11 * (1 - np.exp(-np.arange(len(t)) / 3))
            - 0.025 * (np.arange(len(t)) > 6)
            + rng.normal(0, 0.022, len(t))
        )
        vertices = [
            [
                (t[k], j - 0.28, z[k]),
                (t[k + 1], j - 0.28, z[k + 1]),
                (t[k + 1], j + 0.28, z[k + 1]),
                (t[k], j + 0.28, z[k]),
            ]
            for k in range(len(t) - 1)
        ]
        ax.add_collection3d(
            Poly3DCollection(
                vertices, facecolors=c, edgecolors=".25", linewidths=0.45, alpha=0.88
            )
        )
        ax.plot(t, np.full(len(t), j), z, c=".3", lw=0.55)
    ax.set(
        xlim=(2004, 2022),
        ylim=(-0.5, 7.5),
        zlim=(0, 1),
        xlabel="Year",
        zlabel="Social urbanization ratio",
    )
    ax.set_yticks(range(8), [f"Region {i + 1}" for i in range(8)], fontsize=6)
    ax.set_xticks(t)
    ax.tick_params(axis="x", labelsize=6, pad=0)
    ax.view_init(24, -57)
    ax.set_box_aspect((1.15, 1, 0.85))
    ax.legend(
        handles=[
            Rectangle((0, 0), 1, 1, fc=c, label=f"Region {i + 1}")
            for i, c in enumerate(palette)
        ],
        loc="upper left",
        bbox_to_anchor=(0.0, 0.92),
        fontsize=6,
        labelspacing=0.15,
    )
    export(fig, output_stem)


if __name__ == "__main__":
    make_figure(ROOT / "outputs" / "ribbon_trajectories_3d_replica")
