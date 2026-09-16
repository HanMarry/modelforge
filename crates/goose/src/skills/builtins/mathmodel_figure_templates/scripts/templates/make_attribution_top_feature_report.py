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


def attribution_data(n=200, seed=615):
    """Exact Shapley values for a centered independent-input quadratic toy model.

    f(x)=1.5 + sum(w_i*x_i) + .8*x0*x1 + .4*x2*x3.
    Background: independent inputs of mean zero. Each interaction is split equally.
    No tree, neural-network, or fitted-study attribution is claimed.
    """
    rng = np.random.default_rng(seed)
    x = rng.normal(size=(n, 6))
    weights = np.array([1.2, -0.9, 0.65, 0.4, -0.25, 0.15])
    phi = x * weights
    interactions = np.zeros((n, 6, 6))
    for i, j, weight in [(0, 1, 0.8), (2, 3, 0.4)]:
        half = 0.5 * weight * x[:, i] * x[:, j]
        interactions[:, i, j] = interactions[:, j, i] = half
        phi[:, i] += half
        phi[:, j] += half
    for i in range(6):
        interactions[:, i, i] = x[:, i] * weights[i]
    prediction = 1.5 + phi.sum(1)
    return x, phi, interactions, prediction


def attribution_beeswarm(ax, x, phi):
    order = np.argsort(np.abs(phi).mean(0))
    rng = np.random.default_rng(616)
    for row, feature in enumerate(order):
        ax.scatter(
            phi[:, feature],
            row + rng.uniform(-0.25, 0.25, len(x)),
            c=x[:, feature],
            cmap="coolwarm",
            vmin=-2,
            vmax=2,
            s=8,
            alpha=0.65,
            linewidths=0,
        )
    ax.axvline(0, color="#98A6AE", lw=0.8)
    ax.set(
        yticks=np.arange(len(order)),
        yticklabels=[f"F{i + 1}" for i in order],
        xlabel="Shapley contribution",
    )


def smooth_effect(x, y, degree=3):
    x, y = np.asarray(x, float), np.asarray(y, float)
    grid = np.linspace(x.min(), x.max(), 100)
    design = np.polynomial.polynomial.polyvander(x, degree)
    target = np.polynomial.polynomial.polyvander(grid, degree)
    beta = np.linalg.lstsq(design, y, rcond=None)[0]
    residual = y - design @ beta
    dof = len(x) - design.shape[1]
    covariance = (residual @ residual / dof) * np.linalg.pinv(design.T @ design)
    se = np.sqrt(np.maximum(0, np.einsum("ij,jk,ik->i", target, covariance, target)))
    return grid, target @ beta, stats.t.ppf(0.975, dof) * se, residual


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


def polynomial_summary(x, y, grid, degree=3):
    coefficients, covariance = np.polyfit(x, y, degree, cov=True)
    design = np.vander(grid, degree + 1)
    fitted = design @ coefficients
    variance = np.einsum("ij,jk,ik->i", design, covariance, design)
    ci = stats.t.ppf(0.975, len(x) - degree - 1) * np.sqrt(np.maximum(0, variance))
    residual = y - np.polyval(coefficients, x)
    sse = np.sum(residual**2)
    sst = np.sum((y - y.mean()) ** 2)
    r2 = 1 - sse / sst
    fstat = ((sst - sse) / degree) / (sse / (len(x) - degree - 1))
    p = stats.f.sf(max(0, fstat), degree, len(x) - degree - 1)
    roots = np.roots(coefficients)
    roots = np.sort(
        roots.real[
            (abs(roots.imag) < 1e-7) & (roots.real >= min(x)) & (roots.real <= max(x))
        ]
    )
    return fitted, ci, r2, p, roots


def make_figure(output_stem):
    configure()
    rng = np.random.default_rng(951)
    n = 240
    p = 19
    x = rng.normal(size=(n, p))
    weights = np.geomspace(0.13, 0.018, p)
    phi = (x * x - 1) * weights
    phi[:, 0] *= -1
    phi[:, 1] = -x[:, 1] * weights[1]
    phi[:, 2] = -0.7 * x[:, 2] * weights[2]
    phi[:, 3] = (x[:, 3] ** 2 - 1) * weights[3]
    phi[:, 4] = (0.8 * x[:, 4] - 0.4 * (x[:, 4] ** 2 - 1)) * weights[4]
    mean = np.mean(abs(phi), axis=0)
    order = mean.argsort()[::-1]
    palette = mpl.colormaps["tab20"](np.arange(p) % 20 / 19)
    fig = plt.figure(figsize=(13, 5.5))
    outer = fig.add_gridspec(
        1,
        2,
        width_ratios=[1.05, 2.4],
        left=0.20,
        right=0.985,
        bottom=0.18,
        top=0.91,
        wspace=0.24,
    )
    bar = fig.add_subplot(outer[0])
    bar.barh(range(p), mean[order], color=palette[order], height=0.72)
    bar.set_yticks(range(p), [f"Measured feature {i + 1}" for i in order], fontsize=6)
    bar.invert_yaxis()
    bar.set_xlabel("Mean |SHAP value|")
    bar.spines[["top", "right"]].set_visible(False)
    panel(bar, "a")
    gs = outer[1].subgridspec(2, 3, wspace=0.42, hspace=0.62)
    for k in range(6):
        j = order[k]
        ax = fig.add_subplot(gs[k // 3, k % 3])
        sample = x[:, j]
        response = phi[:, j] + rng.normal(0, 0.02, n)
        grid = np.linspace(-2.7, 2.7, 120)
        fit, band, r2, pvalue, roots = polynomial_summary(
            sample, response, grid, degree=2
        )
        color = palette[j]
        ax.scatter(sample, response, c=[color], s=10, alpha=0.5, lw=0)
        ax.plot(grid, fit, c=color, lw=1.5)
        ax.fill_between(grid, fit - band, fit + band, color=color, alpha=0.12)
        ax.axhline(0, c=".5", ls="--", lw=0.6)
        ax.set_xlabel(f"Feature {j + 1}")
        ax.set_ylabel("SHAP value")
        ax.tick_params(labelsize=6)
        panel(ax, chr(98 + k))
    export(fig, output_stem)


if __name__ == "__main__":
    make_figure(ROOT / "outputs" / "attribution_top_feature_report_replica")
