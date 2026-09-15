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


def panel(ax, letter, title=None):
    ax.text(
        -0.10,
        1.035,
        f"({letter})",
        transform=ax.transAxes,
        fontweight="bold",
        fontsize=10,
        va="bottom",
    )
    if title:
        ax.set_title(title, pad=6)


def violin_boxes(ax, arrays, palette, labels=None, jitter=False, seed=1):
    rng = np.random.default_rng(seed)
    v = ax.violinplot(
        arrays,
        positions=np.arange(len(arrays)),
        widths=0.77,
        showextrema=False,
        points=120,
    )
    for body, color in zip(v["bodies"], palette):
        body.set_facecolor(color)
        body.set_edgecolor(color)
        body.set_alpha(0.80)
        body.set_linewidth(0.6)
    ax.boxplot(
        arrays,
        positions=np.arange(len(arrays)),
        widths=0.11,
        patch_artist=True,
        showfliers=False,
        boxprops=dict(facecolor="white", edgecolor=".35", lw=0.65),
        medianprops=dict(color=".3", lw=0.65),
        whiskerprops=dict(color=".3", lw=0.65),
        capprops=dict(color=".3", lw=0.5),
    )
    if jitter:
        for j, (values, c) in enumerate(zip(arrays, palette)):
            ax.scatter(
                rng.normal(j, 0.055, len(values)),
                values,
                s=3,
                c=c,
                alpha=0.28,
                edgecolors="none",
            )
    ax.set_xticks(
        np.arange(len(arrays)), labels or [f"G{i + 1}" for i in range(len(arrays))]
    )
    return v


def make_figure(output_stem):
    configure()
    rng = np.random.default_rng(912)
    n = 9
    fig, axes = plt.subplots(2, 3, figsize=(10.4, 6.6))
    fig.subplots_adjust(
        left=0.075, right=0.925, bottom=0.13, top=0.94, hspace=0.46, wspace=0.3
    )
    cmap = mpl.colormaps["viridis"]
    means = np.array([85, 86, 83, 74, 89, 81, 80, 88, 84])
    norm = Normalize(70, 90)
    for k, ax in enumerate(axes.flat):
        data = [
            rng.normal(mu + np.sin(k + j) * 1.5, 2.4 + (j % 3) * 0.65, 85)
            for j, mu in enumerate(means)
        ]
        palette = cmap(norm([np.mean(a) for a in data]))
        violin_boxes(ax, data, palette, labels=[f"Method {i + 1}" for i in range(n)])
        ax.set_ylim(68, 101)
        ax.set_yticks([70, 80, 90, 100])
        ax.tick_params(axis="x", labelrotation=90, labelsize=6)
        ax.set_ylabel("Performance (%)")
        ax.set_title(f"Weighted distribution · scenario {k + 1}", fontsize=7)
        ax.grid(axis="y", lw=0.35, alpha=0.22)
        panel(ax, chr(97 + k))
    cax = fig.add_axes([0.951, 0.19, 0.012, 0.66])
    fig.colorbar(
        mpl.cm.ScalarMappable(norm=norm, cmap=cmap), cax=cax, label="Group mean (%)"
    )
    export(fig, output_stem)


if __name__ == "__main__":
    make_figure(ROOT / "outputs" / "violin_mean_trends_replica")
