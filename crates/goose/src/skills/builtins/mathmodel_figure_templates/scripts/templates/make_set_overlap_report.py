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


def membership_counts(sets):
    universe = set().union(*sets)
    return {
        mask: sum(
            sum((item in s) << i for i, s in enumerate(sets)) == mask
            for item in universe
        )
        for mask in range(1, 2 ** len(sets))
    }


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
    rng = np.random.default_rng(716)
    fig = plt.figure(figsize=(10, 7))
    gs = fig.add_gridspec(
        3,
        2,
        height_ratios=[3, 3, 0.7],
        left=0.07,
        right=0.96,
        top=0.92,
        bottom=0.1,
        wspace=0.45,
        hspace=0.35,
    )
    colors = ["#296bff", "#992aff", "#ff35bf"]
    for k in range(4):
        ax = fig.add_subplot(gs[k // 2, k % 2])
        universe = set(range(150))
        a = set(rng.choice(150, 85, replace=False))
        b = set(rng.choice(150, 65, replace=False))
        c = set(rng.choice(150, 55, replace=False))
        regions = [
            len(a - b - c),
            len(b - a - c),
            len(c - a - b),
            len((a & b) - c),
            len((a & c) - b),
            len((b & c) - a),
            len(a & b & c),
        ]
        ax.add_patch(Circle((0, -0.12), 0.92, fc="none", ec=".25", lw=0.7))
        ax.text(0.68, -0.64, str(len(universe - a - b - c)), fontsize=6)
        for center, color, label in zip(
            [(-0.25, 0.12), (0.25, 0.12), (0, -0.28)], colors, ["A", "B", "C"]
        ):
            ax.add_patch(Circle(center, 0.55, fc=color, alpha=0.42, ec=color, lw=0.8))
            ax.text(center[0] * 1.6, center[1] * 1.8, label, ha="center", fontsize=6)
        for (x, y), v in zip(
            [
                (-0.51, 0.2),
                (0.51, 0.2),
                (0, -0.65),
                (0, 0.32),
                (-0.22, -0.25),
                (0.22, -0.25),
                (0, 0),
            ],
            regions,
        ):
            ax.text(x, y, str(v), ha="center", va="center", fontsize=6)
        ax.set(aspect="equal", xlim=(-1, 1.5), ylim=(-1.1, 0.9))
        ax.axis("off")
        ax.set_title(f"({chr(97 + k)}) Scenario {k + 1}", fontsize=8)
        ax.legend(
            handles=[
                Circle((0, 0), 0.1, fc="none", ec=col, label=l)
                for col, l in zip(
                    colors, ["Variable group A", "Variable group B", "Variable group C"]
                )
            ],
            loc="center left",
            bbox_to_anchor=(0.82, 0.5),
            fontsize=5.5,
        )
    legend = fig.add_subplot(gs[2, :])
    legend.axis("off")
    legend.legend(
        handles=[
            Rectangle(
                (0, 0), 1, 1, fc=mpl.colormaps["cool"](j / 8), label=f"Class {j + 1}"
            )
            for j in range(9)
        ],
        loc="center",
        ncol=9,
        fontsize=5.5,
        handlelength=1,
    )
    export(fig, output_stem)


if __name__ == "__main__":
    make_figure(ROOT / "outputs" / "set_overlap_report_replica")
