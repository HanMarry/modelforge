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
    rng = np.random.default_rng(953)
    palette = ["#df8e84", "#e8bc91", "#aad2df", "#a2b4c7"]
    fig, ax = plt.subplots(figsize=(7.3, 5.5))
    fig.subplots_adjust(left=0.13, right=0.97, bottom=0.2, top=0.87)
    scores = []
    for g, c in enumerate(palette):
        x = rng.uniform(0, 1, 130)
        y = [
            lambda z: -0.04 + 0.02 * z,
            lambda z: 0.28 * z * z,
            lambda z: 0.4 * z - 0.45 * z * z,
            lambda z: 0.9 * z - 1.8 * z * z,
        ][g](x) + rng.normal(0, 0.025 + g * 0.007, len(x))
        grid = np.linspace(0, 1, 140)
        fit, ci, r2, pval, roots = polynomial_summary(x, y, grid, degree=2)
        scores.append(1 - (1 - r2) * (len(x) - 1) / (len(x) - 3))
        ax.scatter(x, y, c=c, s=10, lw=0, alpha=0.50)
        ax.plot(grid, fit, c=c, lw=1.2)
        ax.fill_between(grid, fit - ci, fit + ci, color=c, alpha=0.14, lw=0)
    ax.set(
        xlabel="Normalized predictor",
        ylabel="Contribution to model output",
        xlim=(0, 1),
    )
    ax.text(
        0.03,
        0.95,
        "Adjusted R² = " + ", ".join(f"{v:.2f}" for v in scores),
        transform=ax.transAxes,
        fontsize=8,
    )
    ax.text(
        0.97,
        0.07,
        "Response comparison",
        transform=ax.transAxes,
        ha="right",
        fontsize=10,
    )
    ax.legend(
        handles=[
            Rectangle((0, 0), 1, 1, fc=c, label=f"Response {i + 1}")
            for i, c in enumerate(palette)
        ],
        loc="upper center",
        bbox_to_anchor=(0.5, -0.16),
        ncol=4,
        fontsize=6,
    )
    export(fig, output_stem)


if __name__ == "__main__":
    make_figure(ROOT / "outputs" / "multiresponse_effect_curves_replica")
