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
    rng = np.random.default_rng(862)
    fig, ax = plt.subplots(figsize=(6.8, 6.6), subplot_kw=dict(projection="polar"))
    fig.subplots_adjust(left=0.1, right=0.9, top=0.94, bottom=0.17)
    theta = np.array([g * np.pi / 2 + v for g in range(4) for v in [-0.24, 0, 0.24]])
    a = rng.uniform(0.6, 1.6, 12)
    b = rng.uniform(0.3, 1.3, 12)
    ax.set_theta_offset(np.pi / 2)
    ax.set_theta_direction(-1)
    for j, t in enumerate(theta):
        ax.bar(
            t - 0.055,
            a[j],
            bottom=0.6,
            width=0.075,
            color="#f4a531",
            edgecolor=".5",
            lw=0.3,
        )
        ax.bar(
            t + 0.055,
            b[j],
            bottom=0.6,
            width=0.075,
            color="#d27629",
            edgecolor=".5",
            lw=0.3,
        )
        ax.errorbar(
            [t - 0.055, t + 0.055],
            [0.6 + a[j], 0.6 + b[j]],
            yerr=[0.10, 0.07],
            c=".3",
            capsize=2,
            lw=0.6,
        )
        ax.text(
            t,
            2.55,
            f"Factor {j + 1}",
            rotation=90 - np.degrees(t),
            ha="center",
            fontsize=6,
        )
    ax.plot(
        np.r_[theta, theta[0]],
        np.r_[np.full(12, 0.8), 0.8],
        c="#a25e63",
        lw=0.7,
        marker="o",
        ms=2,
    )
    ax.set_ylim(0, 2.8)
    ax.set_yticks([0.6, 1.1, 1.6, 2.1], ["0", ".5", "1", "1.5"], fontsize=5)
    ax.set_xticks([])
    ax.grid(c=".7", lw=0.45)
    ax.legend(
        handles=[
            Line2D(
                [], [], c="#a25e63", marker="o", ms=3, label="Standardized coefficient"
            ),
            Rectangle((0, 0), 1, 1, fc="#f4a531", label="Raw direct effect"),
            Rectangle((0, 0), 1, 1, fc="#d27629", label="Raw indirect effect"),
        ],
        loc="upper center",
        bbox_to_anchor=(0.5, -0.07),
        fontsize=5.5,
        ncol=3,
    )
    export(fig, output_stem)


if __name__ == "__main__":
    make_figure(ROOT / "outputs" / "circular_effect_intervals_replica")
