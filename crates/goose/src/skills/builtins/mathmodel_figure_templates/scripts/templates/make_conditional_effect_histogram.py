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
    rng = np.random.default_rng(831)
    x = rng.normal(size=420)
    condition = rng.normal(size=len(x))
    y = 1.1 * np.exp(-x * x * 0.8) * np.where(condition < 0, 1, -0.65) + rng.normal(
        0, 0.6, len(x)
    )
    fig, ax = plt.subplots(figsize=(8, 5.8))
    fig.subplots_adjust(left=0.12, right=0.82, bottom=0.16, top=0.92)
    hist = ax.twinx()
    hist.hist(x, bins=35, color=".82", alpha=0.55, rwidth=0.82)
    hist.set_ylabel("Distribution count")
    hist.set_zorder(0)
    ax.set_zorder(1)
    ax.patch.set_visible(False)
    sc = ax.scatter(
        x, y, c=condition, cmap="seismic", s=13, lw=0, alpha=0.8, vmin=-2, vmax=2
    )
    for selected, color, label in [
        (condition < 0, "#355391", "Condition < 0"),
        (condition >= 0, "#b5454e", "Condition ≥ 0"),
    ]:
        grid = np.linspace(x.min(), x.max(), 120)
        fit, ci, r2, pvalue, roots = polynomial_summary(
            x[selected], y[selected], grid, degree=4
        )
        ax.plot(grid, fit, c=color, lw=1.3, label=label)
        ax.fill_between(grid, fit - ci, fit + ci, color=color, alpha=0.13)
    ax.axhline(0, c=".2", ls="--", lw=0.6)
    ax.axvline(0, c=".2", ls="--", lw=0.6)
    ax.set_xlabel("Standardized predictor")
    ax.set_ylabel("Contribution")
    ax.legend(loc="upper right", fontsize=7)
    fig.colorbar(
        sc, cax=fig.add_axes([0.92, 0.19, 0.023, 0.67]), label="Conditioning variable"
    )
    export(fig, output_stem)


if __name__ == "__main__":
    make_figure(ROOT / "outputs" / "conditional_effect_histogram_replica")
