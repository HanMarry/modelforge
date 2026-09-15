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
    rng = np.random.default_rng(997)
    n = 30
    fig, ax = plt.subplots(figsize=(5.5, 11))
    fig.subplots_adjust(left=0.27, right=0.84, top=0.94, bottom=0.07)
    cmap = mpl.colormaps["RdYlBu"]
    labels = []
    for row in range(n):
        group = row // 6
        scale = 0.9 * np.exp(-group * 0.85)
        center = (row % 6 - 2.5) * 0.05
        values = rng.normal(center, scale, 45)
        feature = rng.uniform(0, 1, len(values))
        ax.scatter(
            values,
            row + rng.normal(0, 0.065, len(values)),
            c=feature,
            cmap=cmap,
            s=9,
            alpha=0.8,
            lw=0,
        )
        labels.append(f"Zone {group + 1} · F{row % 6 + 1}")
        if row % 6 == 0:
            ax.axhline(row - 0.5, c=".8", lw=0.4)
    ax.set_yticks(range(n), labels, fontsize=5)
    ax.set(
        xlim=(-2.7, 2.7),
        ylim=(n - 0.3, -0.7),
        xlabel="Contribution to model output",
        title="Regional contribution summary",
    )
    ax.axvline(0, c=".5", ls="--", lw=0.6)
    ax.spines[["top", "right"]].set_visible(False)
    fig.colorbar(
        mpl.cm.ScalarMappable(norm=Normalize(0, 1), cmap=cmap),
        cax=fig.add_axes([0.90, 0.15, 0.022, 0.72]),
        label="Feature value",
    )
    export(fig, output_stem)


if __name__ == "__main__":
    make_figure(ROOT / "outputs" / "spatial_attribution_summary_replica")
