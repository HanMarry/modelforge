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


def linear_fit(x, y, grid=None):
    x, y = np.asarray(x, float), np.asarray(y, float)
    if (
        x.ndim != 1
        or x.shape != y.shape
        or len(x) < 4
        or not np.isfinite(x).all()
        or not np.isfinite(y).all()
        or np.ptp(x) == 0
    ):
        raise ValueError("Regression requires matching finite vectors and varying x")
    design = np.column_stack([np.ones(len(x)), x])
    beta = np.linalg.lstsq(design, y, rcond=None)[0]
    residual = y - design @ beta
    variance = residual @ residual / (len(x) - 2)
    grid = np.linspace(x.min(), x.max(), 100) if grid is None else np.asarray(grid)
    target = np.column_stack([np.ones(len(grid)), grid])
    fitted = target @ beta
    se = np.sqrt(
        np.maximum(
            0,
            variance
            * np.einsum(
                "ij,jk,ik->i", target, np.linalg.inv(design.T @ design), target
            ),
        )
    )
    interval = stats.t.ppf(0.975, len(x) - 2) * se
    return grid, fitted, interval, beta, residual


def regression_panel(ax, x, y, color=COLORS[0], label=None):
    grid, fitted, interval, beta, residual = linear_fit(x, y)
    ax.scatter(x, y, s=15, alpha=0.55, color=color, label=label)
    ax.plot(grid, fitted, color=color, lw=1.6)
    ax.fill_between(grid, fitted - interval, fitted + interval, color=color, alpha=0.14)
    return beta


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
        ax.scatter(x, y, s=13, c=color, alpha=0.65, lw=0)
    ax.plot(g, f, c=color, lw=1)
    ax.fill_between(g, f - ci, f + ci, color=color, alpha=0.13, lw=0)
    return fit


def make_figure(output_stem):
    configure()
    rng = np.random.default_rng(983)
    fig = plt.figure(figsize=(6.7, 6.4))
    outer = fig.add_gridspec(1, 1, left=0.13, right=0.95, top=0.95, bottom=0.14)
    ax, top, right = margins(fig, outer[0], ratio=5)
    palette = ["#8f9c62", "#c4a844"]
    for g, c in enumerate(palette):
        x = rng.normal(24 + g * 1.2, 3, 550)
        y = x * 0.94 + g + 0.4 + rng.normal(0, 1.5, len(x))
        fit = line_interval(ax, x, y, c)
        density(top, x, c)
        density(right, y, c, vertical=True)
        r2 = fit.rvalue**2
        rmse = np.sqrt(np.mean((x - y) ** 2))
        text = f"Group {g + 1}\ny = {fit.slope:.2f}x + {fit.intercept:.2f}\nr² = {r2:.2f}; p = {fit.pvalue:.2g}\nRMSE = {rmse:.2f}"
        ax.text(
            0.04 if g == 0 else 0.96,
            0.95 if g == 0 else 0.05,
            text,
            transform=ax.transAxes,
            ha="left" if g == 0 else "right",
            va="top" if g == 0 else "bottom",
            fontsize=6,
            c=c,
            bbox=dict(fc="#fffbdf", ec="none", alpha=0.7, pad=3),
        )
    ax.set(
        xlim=(12, 36),
        ylim=(12, 36),
        xlabel="Measured predictor",
        ylabel="Measured response",
    )
    export(fig, output_stem)


if __name__ == "__main__":
    make_figure(ROOT / "outputs" / "grouped_regression_marginals_replica")
