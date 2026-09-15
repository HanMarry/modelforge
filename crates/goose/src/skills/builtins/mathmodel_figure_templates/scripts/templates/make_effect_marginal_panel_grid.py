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
    rng = np.random.default_rng(939)
    fig = plt.figure(figsize=(15, 10.4))
    outer = fig.add_gridspec(
        3, 5, left=0.055, right=0.985, bottom=0.075, top=0.97, wspace=0.25, hspace=0.32
    )
    for k in range(15):
        gs = outer[k // 5, k % 5].subgridspec(2, 1, height_ratios=[4, 1], hspace=0.01)
        ax = fig.add_subplot(gs[0])
        hist = fig.add_subplot(gs[1], sharex=ax)
        x = np.clip(rng.normal(size=800), -3.5, 3.5)
        if k < 5:
            y = (50 - k * 6) * (x - 0.012 * x**3) + rng.normal(0, 5, len(x))
        elif k < 9:
            y = (9 - (k - 5) * 2) * np.tanh(x) + rng.normal(0, 1, len(x))
        else:
            y = 0.1 * np.sin(x * 2) + rng.normal(0, 0.5, len(x))
        grid = np.linspace(-3.5, 3.5, 180)
        fit, ci, r2, pvalue, roots = polynomial_summary(x, y, grid, degree=5)
        ax.scatter(x, y, c="#455e60", s=5, alpha=0.38, lw=0)
        ax.plot(grid, fit, c="#ef526d", ls="--", lw=1)
        ax.fill_between(grid, fit - ci, fit + ci, color="#ee8195", alpha=0.30, lw=0)
        ax.axhline(0, c=".35", ls=":", lw=0.6)
        for root in roots:
            ax.axvline(root, c="#16b7ef", ls="--", lw=0.6)
            ax.text(
                root,
                0,
                f"{root:.2f}",
                fontsize=4,
                ha="center",
                va="top",
                bbox=dict(fc="white", ec=".5", lw=0.3, pad=1),
            )
        ax.text(
            0.98,
            0.04,
            f"Polynomial fit\nR²={r2:.2f}; 95% mean CI",
            ha="right",
            transform=ax.transAxes,
            fontsize=4.5,
        )
        ax.tick_params(labelbottom=False, labelsize=4.5)
        ax.set_ylabel("Effect (%)", fontsize=6)
        ax.text(
            0.03,
            0.91,
            f"({chr(65 + k)})",
            transform=ax.transAxes,
            fontsize=7,
            fontweight="bold",
        )
        hist.hist(x, bins=40, color="#92a3b4", ec="white", lw=0.3)
        hist.set_yticks([])
        hist.set_ylabel("Dist.", fontsize=5)
        hist.set_xlabel(f"Feature {k + 1}", fontsize=7)
        hist.tick_params(labelsize=5)
        ax.grid(lw=0.3, alpha=0.18)
        hist.grid(lw=0.3, alpha=0.18)
    export(fig, output_stem)


if __name__ == "__main__":
    make_figure(ROOT / "outputs" / "effect_marginal_panel_grid_replica")
