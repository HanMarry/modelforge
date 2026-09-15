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


def ring_dashboard(fig, ax, n=160, rows=10, variant=0):
    rng = np.random.default_rng(706 + variant)
    theta = np.linspace(0.10, 2 * np.pi - 0.10, n, endpoint=False)
    width = (2 * np.pi - 0.20) / n
    data = rng.uniform(0.15, 0.95, (rows, n))
    inner = 2.2
    step = 0.24
    colors = (
        [
            "#f2b580",
            "#dfcba7",
            "#dca7b9",
            "#aaadc9",
            "#82c8cf",
            "#b4d6a5",
            "#d0bcec",
            "#abc7dc",
            "#dba4a0",
            "#dcd9a4",
        ]
        if variant == 0
        else [
            "#e53935",
            "#ee7840",
            "#e9b934",
            "#7cad4c",
            "#529f99",
            "#3c82b0",
            "#4f5594",
        ]
    )
    ax.set_theta_offset(np.pi / 2)
    ax.set_theta_direction(-1)
    for row in range(rows):
        cmap = LinearSegmentedColormap.from_list("ring", ["#fffaf5", colors[row]])
        ax.bar(
            theta,
            np.full(n, step * 0.97),
            width=width * 0.97,
            bottom=inner + row * step,
            color=cmap(data[row]),
            edgecolor="white",
            linewidth=0.06,
        )
    rim = inner + rows * step + 0.12
    categories = mpl.colormaps["tab20"]((np.arange(n) // 8) % 20 / 19)
    ax.bar(
        theta, np.full(n, 0.12), width=width * 0.97, bottom=rim, color=categories, lw=0
    )
    for i in range(n):
        ax.text(
            theta[i],
            rim + 0.35,
            f"Item {i + 1:03}",
            rotation=90 - np.degrees(theta[i]),
            ha="center",
            va="center",
            fontsize=3.4,
        )
    height = np.clip(rng.gamma(1.2, 0.38, n), 0.06, 1.65)
    ax.bar(
        theta,
        height,
        width=width * 0.75,
        bottom=rim + 0.75,
        color="#bfa575" if variant == 0 else "#3483a2",
        lw=0,
    )
    ax.set_ylim(0, rim + 2.55)
    ax.set_xticks([])
    ax.set_yticks([])
    ax.grid(False)
    ax.spines["polar"].set_visible(False)
    for row in range(rows):
        ax.text(0, inner + row * step, f"{row + 1}", fontsize=4, ha="center")
    ax.legend(
        handles=[
            Rectangle((0, 0), 1, 1, fc=colors[j], label=f"Indicator {j + 1}")
            for j in range(rows)
        ],
        loc="center",
        fontsize=5.5,
        handlelength=1,
        borderpad=0,
        labelspacing=0.35,
    )


def make_figure(output_stem):
    configure()
    fig, ax = plt.subplots(figsize=(8, 8), subplot_kw=dict(projection="polar"))
    fig.subplots_adjust(left=0.015, right=0.985, top=0.985, bottom=0.03)
    ring_dashboard(fig, ax, n=160, rows=10, variant=0)
    export(fig, output_stem)


if __name__ == "__main__":
    make_figure(ROOT / "outputs" / "radial_cohort_dashboard_replica")
