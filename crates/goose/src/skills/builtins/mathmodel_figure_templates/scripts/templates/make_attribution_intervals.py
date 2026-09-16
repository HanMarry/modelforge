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


def make_figure(output_stem):
    configure()
    rng = np.random.default_rng(947)
    x, phi = contribution_sample(n=400, p=30, seed=903)
    phi = x * np.r_[1.2, 0.9, 0.65, 0.25, np.geomspace(0.045, 0.001, 26)]
    importance = np.abs(phi)
    mean = importance.mean(0)
    ci = stats.t.ppf(0.975, len(phi) - 1) * stats.sem(importance, axis=0)
    order = mean.argsort()[::-1]
    palette = mpl.colormaps["tab20"](np.arange(30) % 20 / 19)
    fig, ax = plt.subplots(figsize=(5.4, 8.8))
    fig.subplots_adjust(left=0.39, right=0.94, bottom=0.12, top=0.93)
    for row, j in enumerate(order):
        ax.errorbar(
            mean[j], row, xerr=ci[j], fmt="o", c=palette[row], ms=3, lw=0.7, capsize=2
        )
    ax.set_yticks(range(30), [f"Feature {j + 1:02}" for j in order], fontsize=5.5)
    ax.invert_yaxis()
    ax.set_xlabel("Mean |SHAP value| and 95% mean interval", fontsize=7)
    ax.axvline(0, c=".65", ls="--", lw=0.5)
    ax.tick_params(axis="x", labelsize=6)
    export(fig, output_stem)


if __name__ == "__main__":
    make_figure(ROOT / "outputs" / "attribution_intervals_replica")
