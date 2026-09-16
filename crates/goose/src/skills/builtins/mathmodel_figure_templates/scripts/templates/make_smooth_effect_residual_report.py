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


def make_figure(output_stem):
    configure()
    rng = np.random.default_rng(959)
    fig, axes = plt.subplots(4, 4, figsize=(11, 11.5))
    fig.subplots_adjust(
        left=0.065, right=0.98, top=0.88, bottom=0.07, hspace=0.20, wspace=0.20
    )
    cmap = LinearSegmentedColormap.from_list(
        "response", ["#a96521", "#ddc484", "#f3f2ec", "#aedbd4", "#0b8c7f"]
    )
    levels = np.linspace(-0.18, 0.4, 17)
    grid = np.linspace(0, 1, 45)
    xx, yy = np.meshgrid(grid, grid)
    for k, ax in enumerate(axes.flat):
        row = k // 4
        col = k % 4
        z = (
            0.23
            - 0.12 * row
            + 0.18 * np.sin(xx * 5 + col * 0.3) * np.cos(yy * 3)
            + 0.04 * xx * yy
        )
        obs = z + rng.normal(0, 0.02, z.shape)
        rmse = np.sqrt(np.mean((obs - z) ** 2))
        r2 = 1 - np.sum((obs - z) ** 2) / np.sum((obs - obs.mean()) ** 2)
        im = ax.contourf(
            10 + xx * 80, yy * 32, z, levels=levels, cmap=cmap, extend="both"
        )
        ax.contour(
            10 + xx * 80, yy * 32, z, levels=levels, colors="white", linewidths=0.55
        )
        ax.contour(
            10 + xx * 80,
            yy * 32,
            z,
            levels=(levels[:-1] + levels[1:]) / 2,
            colors="white",
            linewidths=0.5,
            linestyles="--",
        )
        ax.set_title(
            f"Group {row + 1}-{col + 1}  R²={r2:.2f}  RMSE={rmse:.3f}",
            fontsize=6.5,
            pad=4,
        )
        ax.tick_params(labelsize=5)
        if row == 3:
            ax.set_xlabel("Predictor A", fontsize=7)
        if col == 0:
            ax.set_ylabel("Predictor B", fontsize=7)
    cb = fig.colorbar(
        mpl.cm.ScalarMappable(norm=Normalize(levels[0], levels[-1]), cmap=cmap),
        cax=fig.add_axes([0.23, 0.945, 0.68, 0.02]),
        orientation="horizontal",
    )
    cb.set_label("Response (unit)", fontsize=8)
    export(fig, output_stem)


if __name__ == "__main__":
    make_figure(ROOT / "outputs" / "smooth_effect_residual_report_replica")
