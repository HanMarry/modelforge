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
    rng = np.random.default_rng(907)
    n = 140
    year = np.linspace(1985, 2025, n)
    x = matrix_demo(n, 4)
    x[:, 0] -= (year - year.mean()) / 10
    x[:, 2] += (year - year.mean()) / 17
    palette = ["#d68191", "#79bfd6", "#80c9a0", "#e3c668"]
    fig = plt.figure(figsize=(10, 7.5))
    outer = fig.add_gridspec(
        1,
        2,
        width_ratios=[4, 1.6],
        left=0.07,
        right=0.98,
        top=0.95,
        bottom=0.10,
        wspace=0.17,
    )
    gs = outer[0].subgridspec(4, 4, wspace=0.1, hspace=0.1)
    for i in range(4):
        for j in range(4):
            ax = fig.add_subplot(gs[i, j])
            if i == j:
                ax.hist(
                    x[:, i],
                    bins=13,
                    density=True,
                    color=palette[i],
                    alpha=0.7,
                    edgecolor="white",
                    lw=0.4,
                )
                density(ax, x[:, i], palette[i], alpha=0.08)
            elif i > j:
                ax.scatter(x[:, j], x[:, i], s=4, c=".18", alpha=0.7, lw=0)
                line_interval(ax, x[:, j], x[:, i], palette[j], scatter=False)
            else:
                rho, p = stats.pearsonr(x[:, j], x[:, i])
                ax.set_facecolor("#f6c4cf" if rho < 0 else "#d9f0e7")
                ax.text(
                    0.5,
                    0.5,
                    f"$R^2$ = {rho * rho:.3f}\np = {p:.2g}\nn = {n}",
                    ha="center",
                    va="center",
                    transform=ax.transAxes,
                    fontsize=7,
                )
                ax.set_xticks([])
                ax.set_yticks([])
            ax.tick_params(labelsize=5, length=2, labelbottom=i == 3, labelleft=j == 0)
            if i == 3:
                ax.set_xlabel(f"X{j + 1}")
            if j == 0:
                ax.set_ylabel(f"X{i + 1}")
    right = outer[1].subgridspec(4, 1, hspace=0.22)
    for i in range(4):
        ax = fig.add_subplot(right[i])
        fit = line_interval(ax, year, x[:, i], palette[i])
        ax.text(
            0.04,
            0.92,
            f"R² = {fit.rvalue**2:.2f}; p = {fit.pvalue:.2g}",
            transform=ax.transAxes,
            fontsize=5,
            va="top",
        )
        ax.tick_params(labelsize=5, labelbottom=i == 3)
        ax.set_ylabel(f"X{i + 1}", fontsize=6)
        ax.spines[["top", "right"]].set_visible(False)
        if i == 3:
            ax.set_xlabel("Year")
    fig.text(0.055, 0.975, "(a)", fontsize=11, fontweight="bold")
    fig.text(0.70, 0.975, "(b)", fontsize=11, fontweight="bold")
    export(fig, output_stem)


if __name__ == "__main__":
    make_figure(ROOT / "outputs" / "time_regression_matrix_replica")
