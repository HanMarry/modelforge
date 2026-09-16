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
    fig, ax = plt.subplots(figsize=(6.1, 6.1), subplot_kw=dict(projection="polar"))
    fig.subplots_adjust(left=0.1, right=0.90, top=0.92, bottom=0.10)
    ax.set_theta_offset(np.pi / 2)
    ax.set_theta_direction(-1)
    values = np.array([181, 194, 209, 224, 237, 252, 274, 290, 310])
    palette = [
        "#254e78",
        "#f1c231",
        "#ea7348",
        "#a75070",
        "#d55b7b",
        "#1e876d",
        "#76bda8",
        "#654881",
        "#25639a",
    ]
    for j, (v, c) in enumerate(zip(values, palette)):
        radius = 2 + j * 0.75
        ax.bar(
            np.deg2rad(v) / 2,
            0.63,
            width=np.deg2rad(v),
            bottom=radius,
            color=c,
            edgecolor="white",
            lw=0.4,
        )
        ax.text(
            -0.03, radius + 0.3, f"Item {j + 1:02}", fontsize=7, ha="right", va="center"
        )
        ax.text(
            np.deg2rad(v) - 0.1,
            radius + 0.32,
            f"{v}",
            fontsize=6,
            color="white",
            rotation=90 - v,
            ha="center",
            va="center",
        )
    ax.set_ylim(0, 9.4)
    ax.set_yticks([])
    ax.set_xticks(
        np.deg2rad(np.arange(0, 360, 54)), [str(x) for x in np.arange(0, 360, 54)]
    )
    ax.grid(False)
    ax.spines["polar"].set_color(".7")
    export(fig, output_stem)


if __name__ == "__main__":
    make_figure(ROOT / "outputs" / "circular_ranking_bars_replica")
