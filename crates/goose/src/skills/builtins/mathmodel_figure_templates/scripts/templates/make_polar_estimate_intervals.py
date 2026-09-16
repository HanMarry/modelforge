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
    rng = np.random.default_rng(854)
    n = 8
    palette = mpl.colormaps["Set3"](np.linspace(0, 1, n))
    fig, ax = plt.subplots(figsize=(7, 7), subplot_kw=dict(projection="polar"))
    fig.subplots_adjust(left=0.08, right=0.93, top=0.96, bottom=0.07)
    ax.set_theta_offset(np.pi / 2)
    ax.set_theta_direction(-1)
    for i, c in enumerate(palette):
        center = i * 2 * np.pi / n
        ax.bar(
            center,
            3,
            width=2 * np.pi / n * 0.92,
            bottom=1.2,
            fc=c,
            alpha=0.15,
            ec=".5",
            lw=0.45,
        )
        for j in range(4):
            theta = center + (j - 1.5) * 0.15
            data = rng.normal(1 + j * 0.3, 0.25, 40)
            mu = data.mean()
            ci = stats.t.ppf(0.975, 39) * stats.sem(data)
            ax.bar(
                theta,
                mu,
                width=0.11,
                bottom=1.2,
                color=["#3dd87e", "#f3df45", "#ee9456", "#f4bfce"][j],
                ec=".25",
                lw=0.35,
            )
            ax.errorbar(theta, 1.2 + mu, yerr=ci, color=".25", lw=0.65, capsize=1.5)
        ax.bar(
            center, 0.20, width=2 * np.pi / n * 0.97, bottom=4.3, fc=c, ec=".5", lw=0.4
        )
        ax.text(
            center,
            4.65,
            f"Category {i + 1}",
            ha="center",
            fontsize=7,
            rotation=90 - np.degrees(center),
        )
    ax.set_ylim(0, 5.05)
    ax.set_xticks([])
    ax.set_yticks([1.2, 2.2, 3.2, 4.2], ["0", "1", "2", "3"], fontsize=5)
    ax.grid(lw=0.4, alpha=0.35)
    ax.spines["polar"].set_visible(False)
    ax.legend(
        handles=[
            Rectangle((0, 0), 1, 1, fc=c, label=f"Series {j + 1}")
            for j, c in enumerate(["#3dd87e", "#f3df45", "#ee9456", "#f4bfce"])
        ],
        loc="center",
        fontsize=5,
    )
    export(fig, output_stem)


if __name__ == "__main__":
    make_figure(ROOT / "outputs" / "polar_estimate_intervals_replica")
