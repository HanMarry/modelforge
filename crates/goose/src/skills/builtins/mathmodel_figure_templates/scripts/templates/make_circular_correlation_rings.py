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
    n = 24
    rows = 5
    rng = np.random.default_rng(893)
    values = np.clip(rng.normal(-0.05, 0.12, (rows, n)), -1, 1)
    fig, ax = plt.subplots(figsize=(7.5, 7), subplot_kw=dict(projection="polar"))
    fig.subplots_adjust(left=0.07, right=0.82, top=0.94, bottom=0.08)
    theta = np.linspace(0.3, 2 * np.pi - 0.30, n, endpoint=False)
    width = (2 * np.pi - 0.60) / n
    ax.set_theta_offset(np.pi / 4)
    ax.set_theta_direction(-1)
    cmap = mpl.colormaps["gist_rainbow"]
    norm = Normalize(-1, 1)
    for row in range(rows):
        for j, t in enumerate(theta):
            ax.bar(
                t,
                0.34,
                width=width * 0.97,
                bottom=1.5 + row * 0.36,
                color=cmap(norm(values[row, j])),
                edgecolor="white",
                lw=0.3,
            )
            ax.text(
                t,
                1.67 + row * 0.36,
                f"{values[row, j]:.1f}",
                ha="center",
                va="center",
                fontsize=4.5,
                rotation=90 - np.degrees(t),
            )
    for j, t in enumerate(theta):
        ax.bar(
            t,
            0.18,
            width=width * 0.96,
            bottom=1.25,
            color=mpl.colormaps["Set1"]((j // 5) / 4),
            lw=0,
        )
        ax.text(
            t,
            3.48,
            f"Trait {j + 1}",
            rotation=90 - np.degrees(t),
            ha="center",
            fontsize=5,
        )
    ax.set_ylim(0, 3.9)
    ax.set_xticks([])
    ax.set_yticks([])
    ax.grid(False)
    ax.spines["polar"].set_visible(False)
    ax.legend(
        handles=[
            Rectangle(
                (0, 0), 1, 1, fc=mpl.colormaps["Set1"](i / 4), label=f"Type {i + 1}"
            )
            for i in range(5)
        ],
        title="Factor type",
        loc="center",
        fontsize=6,
        title_fontsize=7,
    )
    fig.colorbar(
        mpl.cm.ScalarMappable(norm=norm, cmap=cmap),
        cax=fig.add_axes([0.9, 0.22, 0.02, 0.58]),
        label="Correlation",
    )
    export(fig, output_stem)


if __name__ == "__main__":
    make_figure(ROOT / "outputs" / "circular_correlation_rings_replica")
