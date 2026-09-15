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


def make_figure(output_stem):
    configure()
    rng = np.random.default_rng(976)
    x = np.linspace(0, 0.065, 15)
    y = -4 * x + 0.05 + rng.normal(0, 0.027, len(x))
    uncertainty = rng.uniform(0.018, 0.055, len(x))
    colors = rng.uniform(-16, 0, len(x))
    fig, ax = plt.subplots(figsize=(6.2, 5.4))
    fig.subplots_adjust(left=0.17, right=0.95, bottom=0.16, top=0.91)
    ax.errorbar(
        x, y, yerr=uncertainty, fmt="none", ecolor=".7", lw=0.6, capsize=1.5, zorder=1
    )
    cmap = LinearSegmentedColormap.from_list(
        "earth", ["#522752", "#6582a7", "#b7d5dc", "#f4eadf", "#965546"]
    )
    sc = ax.scatter(x, y, c=colors, cmap=cmap, s=42, ec=".2", lw=0.7, zorder=3)
    fit = line_interval(ax, x, y, ".2", scatter=False)
    ax.axhline(0, c=".6", ls="--", lw=0.6)
    ax.text(
        0.95,
        0.94,
        f"Slope = {fit.slope:.2f}\nr = {fit.rvalue:.2f}",
        ha="right",
        va="top",
        transform=ax.transAxes,
        fontsize=9,
    )
    ax.set(
        xlabel="Trend of predictor (unit / decade)",
        ylabel="Trend of response (unit / decade)",
    )
    cb = fig.colorbar(
        sc, cax=ax.inset_axes([0.09, 0.12, 0.35, 0.035]), orientation="horizontal"
    )
    cb.set_label("Trend of conditioning variable", fontsize=6)
    cb.ax.tick_params(labelsize=5)
    export(fig, output_stem)


if __name__ == "__main__":
    make_figure(ROOT / "outputs" / "regression_uncertainty_scatter_replica")
