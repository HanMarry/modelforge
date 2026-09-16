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


def draw_network(ax, matrix, labels=None, threshold=0.35):
    matrix = np.asarray(matrix)
    p = len(matrix)
    angles = np.linspace(0, 2 * np.pi, p, endpoint=False) + np.pi / 2
    xy = np.column_stack([np.cos(angles), np.sin(angles)])
    labels = labels if labels is not None else [f"F{i + 1}" for i in range(p)]
    for i in range(p):
        for j in range(i):
            value = matrix[i, j]
            if abs(value) >= threshold:
                ax.plot(
                    *xy[[i, j]].T,
                    color=COLORS[4] if value > 0 else COLORS[0],
                    lw=0.5 + 3 * abs(value),
                    alpha=0.55,
                    zorder=0,
                )
    strength = np.sum(np.abs(matrix - np.diag(np.diag(matrix))), axis=1)
    ax.scatter(
        *xy.T,
        s=100 + 70 * strength,
        color=[COLORS[i % 6] for i in range(p)],
        edgecolors="white",
        zorder=2,
    )
    for (x, y), label in zip(xy, labels):
        ax.text(1.17 * x, 1.17 * y, label, ha="center", va="center", fontsize=9)
    ax.set(xlim=(-1.4, 1.4), ylim=(-1.4, 1.4), aspect="equal")
    ax.axis("off")
    if np.any(matrix < 0):
        ax.legend(
            handles=[
                mpl.lines.Line2D([], [], color=COLORS[4], label="Positive"),
                mpl.lines.Line2D([], [], color=COLORS[0], label="Negative"),
            ],
            loc="lower center",
            bbox_to_anchor=(0.5, -0.08),
            ncol=2,
            fontsize=8,
        )


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


def matrix_demo(n=150, p=8, seed=942):
    rng = np.random.default_rng(seed)
    latent = rng.normal(size=(n, 4))
    load = rng.normal(size=(4, p))
    x = latent @ load + rng.normal(0, 0.9, (n, p))
    return (x - x.mean(0)) / x.std(0, ddof=1)


def make_figure(output_stem):
    configure()
    rng = np.random.default_rng(930)
    n = 18
    x = matrix_demo(180, n, 847)
    coupling = rng.gamma(0.5, 0.15, (n, n))
    coupling = (coupling + coupling.T) / 2
    coupling[2, 12] = coupling[12, 2] = 1.0
    np.fill_diagonal(coupling, 0)
    strength = coupling / coupling.max()
    theta = np.linspace(0, 2 * np.pi, n, endpoint=False)
    xy = np.c_[np.cos(theta), np.sin(theta)]
    fig, ax = plt.subplots(figsize=(8.2, 7.5))
    fig.subplots_adjust(left=0.09, right=0.78, top=0.9, bottom=0.08)
    for i in range(n):
        for j in range(i):
            ax.plot(
                *xy[[i, j]].T,
                c=mpl.colormaps["Purples"](0.35 + 0.65 * strength[i, j]),
                lw=0.55 + 2.7 * strength[i, j] ** 3,
                alpha=0.65 + 0.30 * strength[i, j],
                zorder=0,
            )
    importance = strength.mean(0)
    sc = ax.scatter(
        *xy.T,
        s=80 + 650 * importance,
        c=importance,
        cmap="Greens",
        vmin=0.04,
        vmax=0.30,
        edgecolors="white",
        lw=0.7,
        zorder=3,
    )
    for i, (px, py) in enumerate(xy):
        ax.text(1.12 * px, 1.12 * py, f"F{i + 1}", ha="center", va="center", fontsize=7)
    ax.set(
        aspect="equal",
        xlim=(-1.25, 1.25),
        ylim=(-1.25, 1.25),
        title="Feature interaction network",
    )
    ax.axis("off")
    fig.colorbar(
        mpl.cm.ScalarMappable(norm=Normalize(0, 1), cmap="Purples"),
        cax=fig.add_axes([0.86, 0.55, 0.022, 0.30]),
        label="Analytic pair coefficient",
    )
    fig.colorbar(
        sc, cax=fig.add_axes([0.86, 0.15, 0.022, 0.30]), label="Node importance"
    )
    export(fig, output_stem)


if __name__ == "__main__":
    make_figure(ROOT / "outputs" / "interaction_network_replica")
