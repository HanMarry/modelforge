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
    rng = np.random.default_rng(965)
    n = 18
    m = 13
    scores = np.geomspace(16, 0.3, n)
    order = np.arange(n)
    values = np.clip(
        np.outer(rng.uniform(0.8, 1.05, m), np.linspace(1, 0, n))
        + rng.normal(0, 0.025, (m, n)),
        0,
        1,
    )
    palette = mpl.colormaps["Spectral"](np.linspace(0.05, 0.95, n))
    fig = plt.figure(figsize=(10.5, 7))
    gs = fig.add_gridspec(
        2,
        2,
        height_ratios=[1, 4],
        width_ratios=[6, 1],
        left=0.10,
        right=0.87,
        bottom=0.23,
        top=0.92,
        hspace=0.03,
        wspace=0.025,
    )
    top = fig.add_subplot(gs[0, 0])
    top.bar(range(n), scores, color=palette, width=0.83)
    top.set_xlim(-0.5, n - 0.5)
    top.tick_params(labelbottom=False, labelsize=6)
    top.set_ylabel("Importance", fontsize=7)
    for j, v in enumerate(scores):
        top.text(j, v + 0.15, f"{v:.2f}", ha="center", fontsize=4.5)
    pie = fig.add_subplot(gs[0, 1])
    pie.pie(
        [0.40, 0.35, 0.25],
        colors=["#83cfd2", "#e17f86", "#f0c889"],
        wedgeprops=dict(width=0.4, ec="white", lw=0.4),
    )
    pie.text(0, 0, "Groups", ha="center", va="center", fontsize=6)
    ax = fig.add_subplot(gs[1, 0])
    im = ax.imshow(values, cmap="RdYlBu_r", aspect="auto", vmin=0, vmax=1)
    ax.set_xticks(
        range(n), [f"Feature {j + 1}" for j in order], rotation=90, fontsize=6
    )
    ax.set_yticks(range(m), [f"Target {j + 1}" for j in range(m)], fontsize=6)
    ax.set_xticks(np.arange(-0.5, n), minor=True)
    ax.set_yticks(np.arange(-0.5, m), minor=True)
    ax.grid(which="minor", c="white", lw=0.4)
    ax.tick_params(which="minor", length=0)
    side = fig.add_subplot(gs[1, 1], sharey=ax)
    fraction = rng.uniform(0.43, 0.48, m)
    summary = np.c_[fraction, 1 - fraction]
    side.imshow(summary, cmap="RdYlBu", aspect="auto", vmin=0.4, vmax=0.6)
    side.tick_params(labelleft=False)
    side.set_xticks([0, 1], ["Share A", "Share B"], rotation=90, fontsize=6)
    for i in range(m):
        for j in range(2):
            side.text(
                j, i, f"{summary[i, j]:.1%}", ha="center", va="center", fontsize=5
            )
    fig.colorbar(
        im, cax=fig.add_axes([0.91, 0.45, 0.018, 0.31]), label="Normalized response"
    )
    fig.legend(
        handles=[
            Rectangle((0, 0), 1, 1, fc=c, label=l)
            for c, l in zip(
                ["#83cfd2", "#e17f86", "#f0c889"], ["Type A", "Type B", "Type C"]
            )
        ],
        loc="lower right",
        bbox_to_anchor=(0.99, 0.25),
        fontsize=6,
    )
    export(fig, output_stem)


if __name__ == "__main__":
    make_figure(ROOT / "outputs" / "ranked_feature_heatmap_replica")
