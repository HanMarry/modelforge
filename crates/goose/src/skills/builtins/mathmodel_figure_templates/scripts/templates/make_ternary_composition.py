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

COLORS = ["#287C8E", "#D58B52", "#7774A6", "#668D62"]


def configure_matplotlib() -> None:
    mpl.rcParams.update(
        {
            "font.family": "DejaVu Sans",
            "font.size": 10,
            "axes.spines.top": False,
            "axes.spines.right": False,
            "axes.labelcolor": "#263742",
            "text.color": "#263742",
            "axes.prop_cycle": mpl.cycler(color=COLORS),
            "legend.frameon": False,
            "pdf.fonttype": 42,
            "svg.fonttype": "none",
        }
    )


def composition_coordinates(values: np.ndarray) -> np.ndarray:
    """Normalize nonnegative A/B/C amounts and project onto an equilateral simplex."""
    values = np.asarray(values, dtype=float)
    if values.ndim != 2 or values.shape[1] != 3 or not np.isfinite(values).all():
        raise ValueError("Composition requires finite rows of three components")
    if np.any(values < 0) or np.any(values.sum(axis=1) <= 0):
        raise ValueError("Components must be nonnegative with positive row totals")
    fractions = values / values.sum(axis=1, keepdims=True)
    return fractions @ np.array([[0, 0], [1, 0], [0.5, np.sqrt(3) / 2]])


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
    rng = np.random.default_rng(708)
    share = rng.dirichlet([2.4, 6, 2.2], 220)
    xy = np.column_stack([share[:, 1] + share[:, 2] / 2, share[:, 2] * np.sqrt(3) / 2])
    values = 5000 + 14000 * (share[:, 1] * 0.7 + share[:, 2] * 0.3)
    sizes = 8 + 42 * rng.random(len(xy))
    fig, ax = plt.subplots(figsize=(6.4, 5.6))
    fig.subplots_adjust(left=0.08, right=0.78, top=0.86, bottom=0.13)
    h = np.sqrt(3) / 2
    ax.plot([0, 1, 0.5, 0], [0, 0, h, 0], c=".3", lw=0.7)
    for v in np.arange(0.2, 1, 0.2):
        ax.plot([v / 2, 1 - v / 2], [v * h, v * h], c=".45", ls="--", lw=0.4)
        ax.plot([v, v / 2], [0, v * h], c=".45", ls="--", lw=0.4)
        ax.plot([v, 0.5 + v / 2], [0, (1 - v) * h], c=".45", ls="--", lw=0.4)
    sc = ax.scatter(
        *xy.T, c=values, s=sizes, cmap="magma_r", alpha=0.65, edgecolors=".35", lw=0.25
    )
    for k in range(6):
        v = k / 5
        ax.text(v, -0.035, f"{100 * v:.0f}", ha="center", fontsize=7)
        ax.text(v / 2 - 0.035, v * h, f"{100 * v:.0f}", ha="right", fontsize=7)
        ax.text(1 - v / 2 + 0.035, v * h, f"{100 * (1 - v):.0f}", ha="left", fontsize=7)
    ax.text(0.5, -0.095, "Ecological quality", ha="center")
    ax.text(0.14, 0.49, "Social demand", rotation=60, ha="center")
    ax.text(0.86, 0.49, "Environmental supply", rotation=-60, ha="center")
    ax.set_title("Three-component composition", y=1.09, fontweight="bold")
    ax.set(aspect="equal", xlim=(-0.13, 1.13), ylim=(-0.13, h + 0.06))
    ax.axis("off")
    cb = fig.colorbar(sc, cax=fig.add_axes([0.84, 0.2, 0.025, 0.36]))
    cb.set_label("Continuous response")
    ax.legend(
        handles=[
            plt.scatter([], [], s=s, fc="none", ec=".5", lw=0.5, label=l)
            for s, l in zip([12, 28, 46], ["Small", "Medium", "Large"])
        ],
        title="Observation size",
        bbox_to_anchor=(1.34, 1.02),
        loc="upper right",
        labelspacing=1.1,
        fontsize=6,
        title_fontsize=7,
    )
    export(fig, output_stem)


if __name__ == "__main__":
    make_figure(ROOT / "outputs" / "ternary_composition_replica")
