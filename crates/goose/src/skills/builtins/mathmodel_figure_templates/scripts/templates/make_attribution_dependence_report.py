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


def contribution_sample(n=350, p=18, seed=667):
    rng = np.random.default_rng(seed)
    x = rng.normal(size=(n, p))
    weights = np.geomspace(0.85, 0.015, p)
    weights[1::3] *= -1
    phi = x * weights[None, :]
    return x, phi


def swarm_rows(ax, x, phi, labels=None, cmap="coolwarm", order=None):
    p = phi.shape[1]
    order = np.argsort(np.mean(np.abs(phi), axis=0))[::-1] if order is None else order
    rng = np.random.default_rng(312)
    for row, j in enumerate(order):
        values = phi[:, j]
        normx = np.clip((x[:, j] - x[:, j].min()) / (np.ptp(x[:, j]) + 1e-12), 0, 1)
        dens = stats.gaussian_kde(values)(values)
        height = 0.3 * dens / (dens.max() + 1e-12)
        ax.scatter(
            values,
            row + rng.uniform(-1, 1, len(x)) * height,
            c=normx,
            cmap=cmap,
            vmin=0,
            vmax=1,
            s=3,
            alpha=0.7,
            lw=0,
        )
    ax.axvline(0, c=".4", lw=0.6)
    ax.set_yticks(
        range(p), labels if labels is not None else [f"Feature {j + 1}" for j in order]
    )
    ax.invert_yaxis()
    ax.set_xlabel("Contribution to model output")
    ax.grid(axis="y", lw=0.35, alpha=0.18)
    return order


def make_figure(output_stem):
    configure()
    rng = np.random.default_rng(930)
    x, phi = contribution_sample(n=300, p=19, seed=843)
    phi = np.tanh(x * 1.8) * np.geomspace(0.9, 0.009, 19)
    phi[:, 1] = np.floor(x[:, 1] * 1.5) * 0.24
    phi[:, 2] = 0.5 / (abs(x[:, 2]) + 0.25) - 0.7
    phi[:, 3] = 0.2 * x[:, 3] ** 2 - 0.2
    phi -= phi.mean(0)
    order = np.argsort(np.mean(abs(phi), axis=0))[::-1]
    fig = plt.figure(figsize=(13.5, 9.5))
    outer = fig.add_gridspec(
        1,
        2,
        width_ratios=[1.1, 1.25],
        left=0.15,
        right=0.96,
        top=0.91,
        bottom=0.10,
        wspace=0.32,
    )
    left = fig.add_subplot(outer[0])
    swarm_rows(left, x, phi, cmap="viridis", order=order)
    top = left.twiny()
    top.barh(
        range(19), np.mean(abs(phi), axis=0)[order], color=".85", alpha=0.5, height=0.66
    )
    top.set_ylim(left.get_ylim())
    top.set_xlabel("Mean absolute contribution (global importance)", fontsize=7)
    top.set_zorder(0)
    left.set_zorder(1)
    left.patch.set_visible(False)
    fig.colorbar(
        mpl.cm.ScalarMappable(norm=Normalize(0, 1), cmap="viridis"),
        cax=fig.add_axes([0.515, 0.17, 0.012, 0.64]),
        label="Feature value",
    )
    gs = outer[1].subgridspec(3, 2, hspace=0.55, wspace=0.38)
    target = phi.sum(1)
    for k in range(6):
        j = order[k]
        ax = fig.add_subplot(gs[k // 2, k % 2])
        values = x[:, j]
        response = phi[:, j]
        sc = ax.scatter(
            values, response, c=target, cmap="viridis", s=10, lw=0, alpha=0.75
        )
        median = np.median(values)
        cut = np.quantile(values, 0.65)
        ax.axvline(median, c=".25", ls="--", lw=0.75)
        ax.axvline(cut, c="#e36767", ls=":", lw=0.9)
        ax.legend(
            handles=[
                Line2D([], [], c=".25", ls="--", label=f"Median: {median:.2f}"),
                Line2D(
                    [], [], c="#e36767", ls=":", label=f"65th percentile: {cut:.2f}"
                ),
            ],
            loc="best",
            fontsize=5,
        )
        ax.set_xlabel(f"Feature {j + 1}")
        ax.set_ylabel("SHAP value")
        ax.tick_params(labelsize=6)
        fig.colorbar(sc, ax=ax, fraction=0.045, pad=0.02).ax.tick_params(labelsize=4)
    export(fig, output_stem)


if __name__ == "__main__":
    make_figure(ROOT / "outputs" / "attribution_dependence_report_replica")
