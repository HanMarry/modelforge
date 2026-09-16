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


def composition_data():
    rng = np.random.default_rng(612)
    values = rng.gamma(2.5, 1, (6, 4))
    return values / values.sum(1, keepdims=True) * 100


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
    rng = np.random.default_rng(923)
    values = rng.dirichlet([84, 20, 30, 34, 28], 6) * 100
    palette = ["#853535", "#ba5a4d", "#e2a779", "#f3d875", "#cde1e9"]
    fig, ax = plt.subplots(figsize=(8, 4.8))
    fig.subplots_adjust(left=0.12, right=0.77, top=0.92, bottom=0.16)
    starts = np.c_[np.zeros(6), np.cumsum(values, axis=1)[:, :-1]]
    for i in range(6):
        for j, c in enumerate(palette):
            ax.barh(
                i,
                values[i, j],
                left=starts[i, j],
                height=0.78,
                color=c,
                edgecolor="white",
                lw=0.5,
            )
            ax.text(
                starts[i, j] + values[i, j] / 2,
                i,
                f"{values[i, j]:.2f}",
                ha="center",
                va="center",
                fontsize=7,
                color="white" if j < 2 else ".25",
            )
            if i < 5:
                a, b = starts[i, j], starts[i + 1, j]
                ax.add_patch(
                    Polygon(
                        [
                            (a, i + 0.39),
                            (a + values[i, j], i + 0.39),
                            (b + values[i + 1, j], i + 0.61),
                            (b, i + 0.61),
                        ],
                        fc=c,
                        alpha=0.25,
                        ec="none",
                    )
                )
    ax.set(
        xlim=(0, 100),
        yticks=range(6),
        yticklabels=["Baseline"] + [f"S{i + 1}" for i in range(5)],
        xlabel="Proportion (%)",
    )
    ax.spines[["top", "right"]].set_visible(False)
    ax.legend(
        handles=[
            Rectangle((0, 0), 1, 1, fc=c, label=l)
            for c, l in zip(
                palette,
                ["Rainfed", "Agricultural", "Domestic", "Irrigation", "Industry"],
            )
        ],
        loc="upper left",
        bbox_to_anchor=(1.02, 1),
        fontsize=7,
    )
    export(fig, output_stem)


if __name__ == "__main__":
    make_figure(ROOT / "outputs" / "horizontal_share_bars_replica")
