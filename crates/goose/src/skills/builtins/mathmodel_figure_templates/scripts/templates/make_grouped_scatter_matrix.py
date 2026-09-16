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


def example_data(n=150, p=6, seed=610):
    rng = np.random.default_rng(seed)
    group = np.arange(n) % 3
    latent = rng.normal(size=(n, 3))
    latent[:, 0] += (group - 1) * 0.8
    weights = rng.normal(size=(3, p))
    x = latent @ weights + rng.normal(0, 0.5, (n, p))
    x = (x - x.mean(0)) / x.std(0, ddof=1)
    return x, group


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


def density(ax, values, color, vertical=False, alpha=0.38, limits=None):
    values = np.asarray(values, float)
    grid = np.linspace(
        *(
            limits
            if limits is not None
            else (values.min() - values.std() * 0.6, values.max() + values.std() * 0.6)
        ),
        180,
    )
    y = stats.gaussian_kde(values)(grid)
    if vertical:
        ax.fill_betweenx(grid, 0, y, color=color, alpha=alpha, lw=0)
        ax.plot(y, grid, color=color, lw=0.65)
    else:
        ax.fill_between(grid, 0, y, color=color, alpha=alpha, lw=0)
        ax.plot(grid, y, color=color, lw=0.65)
    return grid, y


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


def line_interval(ax, x, y, color, scatter=True):
    x = np.asarray(x)
    y = np.asarray(y)
    fit = stats.linregress(x, y)
    g = np.linspace(x.min(), x.max(), 120)
    residual = y - (fit.intercept + fit.slope * x)
    sigma = np.sqrt(np.sum(residual**2) / (len(x) - 2))
    se = sigma * np.sqrt(1 / len(x) + (g - x.mean()) ** 2 / np.sum((x - x.mean()) ** 2))
    ci = stats.t.ppf(0.975, len(x) - 2) * se
    f = fit.intercept + fit.slope * g
    if scatter:
        ax.scatter(x, y, s=6, c=color, alpha=0.40, lw=0)
    ax.plot(g, f, c=color, lw=1)
    ax.fill_between(g, f - ci, f + ci, color=color, alpha=0.13, lw=0)
    return fit


def matrix_demo(n=150, p=8, seed=942):
    rng = np.random.default_rng(seed)
    latent = rng.normal(size=(n, 4))
    load = rng.normal(size=(4, p))
    x = latent @ load + rng.normal(0, 0.9, (n, p))
    return (x - x.mean(0)) / x.std(0, ddof=1)


def make_figure(output_stem):
    configure()
    rng = np.random.default_rng(917)
    x = matrix_demo(210, 4, 882)
    groups = np.arange(len(x)) % 3
    x += groups[:, None] * 0.4
    palette = ["#dd8e87", "#9cce97", "#63b8c9"]
    fig = plt.figure(figsize=(9.5, 9))
    gs = fig.add_gridspec(
        5, 5, left=0.10, right=0.97, top=0.94, bottom=0.12, hspace=0.13, wspace=0.11
    )
    for i in range(5):
        for j in range(5):
            ax = fig.add_subplot(gs[i, j])
            if i < 4 and j < 4:
                if i == j:
                    for g, c in enumerate(palette):
                        density(ax, x[groups == g, i], c, alpha=0.45)
                elif i > j:
                    for g, c in enumerate(palette):
                        z = groups == g
                        line_interval(ax, x[z, j], x[z, i], c)
                else:
                    for g, c in enumerate(palette):
                        z = groups == g
                        rho, p = stats.pearsonr(x[z, j], x[z, i])
                        ax.text(
                            0.5,
                            0.85 - g * 0.20,
                            f"r={rho:.2f}  p={p:.2g}",
                            ha="center",
                            transform=ax.transAxes,
                            c=c,
                            fontsize=5,
                        )
                    ax.set_xticks([])
                    ax.set_yticks([])
            elif j == 4 and i < 4:
                violin_boxes(
                    ax,
                    [x[groups == g, i] for g in range(3)],
                    palette,
                    labels=["A", "B", "C"],
                )
                ax.tick_params(labelsize=5)
            elif i == 4 and j < 4:
                ax.hist(
                    [x[groups == g, j] for g in range(3)],
                    bins=9,
                    color=palette,
                    alpha=0.85,
                    label=["A", "B", "C"],
                    rwidth=0.95,
                )
            else:
                ax.bar(range(3), [sum(groups == g) for g in range(3)], color=palette)
                ax.set_xticks(range(3), ["A", "B", "C"], fontsize=5)
            ax.tick_params(
                labelsize=4.5,
                length=1.5,
                labelbottom=i == 4 or j == 4,
                labelleft=j == 0,
            )
            ax.spines[["top", "right"]].set_visible(False)
            if i == 4 and j < 4:
                ax.set_xlabel(f"Variable {j + 1}", fontsize=6)
            if j == 0 and i < 4:
                ax.set_ylabel(f"Variable {i + 1}", fontsize=6)
    export(fig, output_stem)


if __name__ == "__main__":
    make_figure(ROOT / "outputs" / "grouped_scatter_matrix_replica")
