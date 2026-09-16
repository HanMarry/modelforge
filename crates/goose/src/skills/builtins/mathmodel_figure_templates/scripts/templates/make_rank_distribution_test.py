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


def group_samples(seed=613):
    rng = np.random.default_rng(seed)
    return [
        rng.normal(mean, sd, 42)
        for mean, sd in [(0, 0.65), (0.7, 0.55), (1.1, 0.8), (1.6, 0.5)]
    ]


def violin_panel(ax, samples, labels=None):
    parts = ax.violinplot(samples, showextrema=False, showmedians=False, widths=0.75)
    for i, body in enumerate(parts["bodies"]):
        body.set_facecolor(COLORS[i % 6])
        body.set_edgecolor(COLORS[i % 6])
        body.set_alpha(0.6)
    for i, values in enumerate(samples, 1):
        lower, median, upper = np.quantile(values, [0.25, 0.5, 0.75])
        ax.plot([i, i], [lower, upper], color="#263742", lw=3)
        ax.scatter([i], [median], s=22, color="white", zorder=4)
    ax.set(
        xticks=np.arange(1, len(samples) + 1),
        xticklabels=labels or [f"G{i + 1}" for i in range(len(samples))],
    )


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
    rng = np.random.default_rng(718)
    arrays = [rng.normal(34, 12, 65), rng.normal(76, 14, 65)]
    palette = ["#e4be70", "#d98791"]
    fig, ax = plt.subplots(figsize=(4.8, 5.1))
    fig.subplots_adjust(left=0.18, right=0.95, bottom=0.17, top=0.92)
    for j, (values, c) in enumerate(zip(arrays, palette)):
        v = ax.violinplot(
            [values], positions=[j], showextrema=False, widths=0.85, points=150
        )
        for body in v["bodies"]:
            xy = body.get_paths()[0].vertices
            xy[:, 0] = np.minimum(xy[:, 0], j) if j == 0 else np.maximum(xy[:, 0], j)
            body.set_facecolor(c)
            body.set_edgecolor(c)
            body.set_facecolor("none")
            body.set_alpha(0.55)
            body.set_linewidth(1)
        ax.boxplot(
            [values],
            positions=[j],
            widths=0.29,
            patch_artist=True,
            showfliers=False,
            boxprops=dict(fc=c, ec=c, alpha=0.55, lw=0.7),
            medianprops=dict(c=c, lw=1),
            whiskerprops=dict(c=c, lw=0.8),
            capprops=dict(c=c, lw=0.8),
        )
        ax.scatter(
            rng.normal(j, 0.075, len(values)), values, c=c, s=7, alpha=0.35, lw=0
        )
    p = stats.mannwhitneyu(*arrays, alternative="two-sided").pvalue
    stars = (
        "****"
        if p < 0.0001
        else "***"
        if p < 0.001
        else "**"
        if p < 0.01
        else "*"
        if p < 0.05
        else "ns"
    )
    ax.plot([0, 1], [115, 115], c=palette[1], lw=1)
    ax.text(0.5, 117, stars, ha="center", c=palette[1], fontsize=10)
    ax.set(xlim=(-0.65, 1.65), ylim=(0, 125), ylabel="Value (unit)", xlabel="Group")
    ax.set_xticks([0, 1], ["Group A", "Group B"])
    export(fig, output_stem)


if __name__ == "__main__":
    make_figure(ROOT / "outputs" / "rank_distribution_test_replica")
