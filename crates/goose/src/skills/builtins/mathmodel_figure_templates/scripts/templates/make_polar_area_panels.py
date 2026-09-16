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
    rng = np.random.default_rng(913)
    n = 14
    fig, axes = plt.subplots(
        3, 3, figsize=(9.5, 9.2), subplot_kw=dict(projection="polar")
    )
    fig.subplots_adjust(
        left=0.04, right=0.98, bottom=0.045, top=0.955, hspace=0.35, wspace=0.22
    )
    cmap = mpl.colormaps["Spectral"]
    palette = cmap(np.linspace(0.06, 0.94, n))
    theta = np.arange(n) * 2 * np.pi / n
    for k, ax in enumerate(axes.flat):
        values = rng.dirichlet(np.ones(n) * 24) * 100
        radii = 0.6 + values / 11
        ax.set_theta_offset(np.pi / 2)
        ax.set_theta_direction(-1)
        for j in range(n):
            for ring in range(4):
                ax.bar(
                    theta[j],
                    (radii[j] - 0.6) / 4,
                    width=2 * np.pi / n * 0.94,
                    bottom=0.6 + (radii[j] - 0.6) * ring / 4,
                    color=palette[j],
                    alpha=0.6 + 0.1 * ring,
                    edgecolor="white",
                    lw=0.25,
                )
            ax.text(
                theta[j],
                radii[j] + 0.16,
                f"{values[j]:.1f}%",
                fontsize=4.6,
                rotation=np.degrees(-theta[j]),
                ha="center",
                va="center",
            )
        ax.set_ylim(0, 1.85)
        ax.set_xticks([])
        ax.set_yticks([])
        ax.spines["polar"].set_visible(False)
        ax.grid(False)
        ax.set_title(f"Indicator {k + 1}", fontsize=8, y=1.04)
        handles = [
            Rectangle((0, 0), 1, 1, fc=palette[j], label=f"C{j + 1}") for j in range(n)
        ]
        ax.legend(
            handles=handles,
            loc="center left",
            bbox_to_anchor=(0.93, 0.5),
            fontsize=3.8,
            handlelength=0.7,
            handleheight=0.7,
            labelspacing=0.12,
            borderpad=0,
        )
    export(fig, output_stem)


if __name__ == "__main__":
    make_figure(ROOT / "outputs" / "polar_area_panels_replica")
