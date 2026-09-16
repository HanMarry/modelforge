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
    rng = np.random.default_rng(986)
    fig, axes = plt.subplots(3, 3, figsize=(10.5, 9.3))
    fig.subplots_adjust(
        left=0.08, right=0.97, top=0.96, bottom=0.085, hspace=0.35, wspace=0.32
    )
    for k, ax in enumerate(axes.flat):
        x = rng.uniform(-2.6, 2.6, 160)
        y = (0.8 - k * 0.06) * (
            np.tanh(x * (0.8 + k * 0.05)) + 0.12 * np.sin(x * (k % 3 + 2))
        ) + rng.normal(0, 0.08, len(x))
        grid = np.linspace(-2.6, 2.6, 140)
        fit, ci, r2, pvalue, roots = polynomial_summary(x, y, grid, degree=3)
        ax.set_facecolor("#f6f6f6")
        ax.plot(grid, fit, c="#426397", lw=1.15)
        ax.fill_between(grid, fit - ci, fit + ci, color="#8798b9", alpha=0.28, lw=0)
        ax.fill_between(grid, 0, fit, where=fit >= 0, fc="#d2ead6", alpha=0.65)
        ax.fill_between(grid, 0, fit, where=fit < 0, fc="#f6d7dd", alpha=0.65)
        ax.axhline(0, c=".55", ls="--", lw=0.55)
        if len(roots):
            root = roots[np.argmin(abs(roots))]
            ax.axvline(root, c="#ef7777", ls="--", lw=0.7)
            ax.scatter(root, 0, s=22, c="#ef7777", ec="white", lw=0.5, zorder=5)
            ax.annotate(
                f"{root:.2f}",
                xy=(root, 0),
                xytext=(0, 12),
                textcoords="offset points",
                ha="center",
                fontsize=8,
                bbox=dict(boxstyle="round,pad=.2", fc="white", ec="#ef7777", lw=0.6),
            )
        ax.text(
            0.03, 0.94, f"R² = {r2:.3f}", va="top", transform=ax.transAxes, fontsize=8
        )
        ax.text(
            0.97,
            0.94,
            f"p = {pvalue:.1g}",
            ha="right",
            va="top",
            transform=ax.transAxes,
            fontsize=7,
        )
        ax.text(
            0.03, 0.06, f"({chr(97 + k)})", transform=ax.transAxes, fontweight="bold"
        )
        ax.set_xlabel(f"Feature {k + 1}")
        ax.set_ylabel("Contribution")
        ax.legend(
            handles=[
                Rectangle((0, 0), 1, 1, fc="#d2ead6", label="Positive"),
                Rectangle((0, 0), 1, 1, fc="#f6d7dd", label="Negative"),
            ],
            loc="lower right",
            fontsize=6,
        )
    export(fig, output_stem)


if __name__ == "__main__":
    make_figure(ROOT / "outputs" / "attribution_threshold_report_replica")
