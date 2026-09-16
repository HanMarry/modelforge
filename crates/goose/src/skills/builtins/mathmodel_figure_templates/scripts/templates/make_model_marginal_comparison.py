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

from matplotlib.colors import LinearSegmentedColormap, ListedColormap, BoundaryNorm
from matplotlib.patches import Rectangle, PathPatch
from matplotlib.path import Path as MplPath
from matplotlib.lines import Line2D
from matplotlib import cm


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


def margins(fig, spec, ratio=5):
    gs = spec.subgridspec(
        2,
        2,
        height_ratios=[1, ratio],
        width_ratios=[ratio, 1],
        hspace=0.025,
        wspace=0.025,
    )
    ax = fig.add_subplot(gs[1, 0])
    top = fig.add_subplot(gs[0, 0], sharex=ax)
    right = fig.add_subplot(gs[1, 1], sharey=ax)
    for a in (top, right):
        a.tick_params(left=False, bottom=False, labelleft=False, labelbottom=False)
        for s in a.spines.values():
            s.set_visible(False)
    return ax, top, right


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
    rng = np.random.default_rng(939)
    fig = plt.figure(figsize=(12, 9))
    outer = fig.add_gridspec(
        2, 3, left=0.07, right=0.985, bottom=0.08, top=0.96, wspace=0.31, hspace=0.34
    )
    for k in range(6):
        gs = outer[k // 3, k % 3].subgridspec(
            3,
            2,
            height_ratios=[0.65, 4.4, 0.9],
            width_ratios=[4.8, 0.7],
            hspace=0.04,
            wspace=0.015,
        )
        ax = fig.add_subplot(gs[1, 0])
        top = fig.add_subplot(gs[0, 0], sharex=ax)
        side = fig.add_subplot(gs[1, 1], sharey=ax)
        res = fig.add_subplot(gs[2, 0], sharex=ax)
        actual = rng.normal(8, 1.5, 1600)
        pred = actual + rng.normal(
            0, [1.45, 0.30, 0.19, 0.36, 0.94, 0.27][k], len(actual)
        )
        errors = actual - pred
        ax.scatter(
            pred,
            actual,
            s=8,
            marker=r"$\epsilon$",
            c=actual,
            cmap="copper",
            alpha=0.72,
            lw=0.15,
            edgecolors=".12",
        )
        ax.plot([0, 14], [0, 14], c="#22cabb", ls="--", lw=0.8)
        ax.set(xlim=(0, 14), ylim=(0, 14), ylabel="Observed value (unit)")
        ax.tick_params(labelbottom=False, labelsize=6)
        for marginal, values, vertical in [(top, pred, False), (side, actual, True)]:
            counts, bins = np.histogram(values, bins=24, density=True)
            height = counts.max()
            gradient = np.linspace(0, 1, 80)
            for j, h in enumerate(counts):
                a, b = bins[j : j + 2]
                if vertical:
                    marginal.imshow(
                        gradient[None, :],
                        extent=(0, h, a, b),
                        cmap="Reds",
                        origin="lower",
                        aspect="auto",
                        vmin=0,
                        vmax=1,
                    )
                    marginal.add_patch(
                        Rectangle((0, a), h, b - a, fc="none", ec=".2", lw=0.45)
                    )
                else:
                    marginal.imshow(
                        gradient[:, None],
                        extent=(a, b, 0, h),
                        cmap="Blues",
                        origin="lower",
                        aspect="auto",
                        vmin=0,
                        vmax=1,
                    )
                    marginal.add_patch(
                        Rectangle((a, 0), b - a, h, fc="none", ec=".2", lw=0.45)
                    )
            grid = np.linspace(0, 14, 150)
            dens = stats.gaussian_kde(values)(grid)
            if vertical:
                marginal.plot(dens, grid, c="#20c7b3", lw=0.75)
                marginal.set_xlim(0, height * 1.15)
            else:
                marginal.plot(grid, dens, c="#d48431", lw=0.75)
                marginal.set_ylim(0, height * 1.15)
            marginal.axis("off")
        res.scatter(
            pred,
            errors,
            s=6,
            marker=r"$\epsilon$",
            c=actual,
            cmap="copper",
            alpha=0.65,
            lw=0.1,
            edgecolors=".12",
        )
        res.axhline(0, c=".2", ls="--", lw=0.6)
        res.set_ylabel("Error", fontsize=7)
        res.set_xlabel("Predicted value (unit)")
        res.tick_params(labelsize=6)
        res.set_ylim(-max(abs(errors)) * 1.15, max(abs(errors)) * 1.15)
        r2 = 1 - np.sum(errors**2) / np.sum((actual - actual.mean()) ** 2)
        rmse = np.sqrt(np.mean(errors**2))
        mae = np.mean(np.abs(errors))
        ax.text(
            0.04,
            0.96,
            f"Model {k + 1}\nR² = {r2:.4f}\nRMSE = {rmse:.4f}\nMAE = {mae:.4f}\nn = {len(pred)}",
            transform=ax.transAxes,
            fontsize=6,
            va="top",
        )
        top.text(
            -0.15,
            0.9,
            chr(97 + k),
            transform=top.transAxes,
            fontweight="bold",
            fontsize=11,
        )
    export(fig, output_stem)


if __name__ == "__main__":
    make_figure(ROOT / "outputs" / "model_marginal_comparison_replica")
