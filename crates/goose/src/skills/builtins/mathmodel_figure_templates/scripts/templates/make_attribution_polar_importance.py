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
    x, phi = contribution_sample(n=350, p=20, seed=818)
    order = np.argsort(np.mean(abs(phi), axis=0))[::-1]
    mean = np.mean(abs(phi), axis=0)[order]
    fig = plt.figure(figsize=(11, 7.8))
    gs = fig.add_gridspec(
        1,
        2,
        width_ratios=[1.5, 1],
        left=0.10,
        right=0.88,
        top=0.93,
        bottom=0.13,
        wspace=0.035,
    )
    bar = fig.add_subplot(gs[0])
    swarm = fig.add_subplot(gs[1])
    cmap = LinearSegmentedColormap.from_list(
        "importance", ["#174ee4", "#783baf", "#ee2b37"]
    )
    palette = cmap(np.linspace(1, 0, 20))
    bar.barh(range(20), mean, color=palette, height=0.69)
    bar.set_xlim(mean.max() * 1.1, 0)
    bar.set_yticks(range(20), [f"Feature {j + 1}" for j in order], fontsize=6)
    bar.yaxis.tick_right()
    bar.invert_yaxis()
    bar.set_xlabel("Mean absolute contribution")
    bar.tick_params(axis="y", pad=-70, length=0)
    bar.spines[["top", "left"]].set_visible(False)
    swarm_rows(swarm, x, phi, labels=[""] * 20, cmap=cmap, order=order)
    swarm.spines[["top", "right", "left"]].set_visible(False)
    swarm.set_ylim(19.7, -0.7)
    swarm.set_xlabel("SHAP value")
    swarm.tick_params(axis="y", length=0)
    polar = fig.add_axes([0.13, 0.19, 0.23, 0.26], projection="polar")
    theta = np.arange(20) * 2 * np.pi / 20
    polar.bar(
        theta,
        0.4 + np.sqrt(mean / mean.max()),
        bottom=0.28,
        width=2 * np.pi / 20 * 0.93,
        color=palette,
        lw=0,
    )
    polar.set_xticks([])
    polar.set_yticks([])
    polar.grid(False)
    polar.spines["polar"].set_visible(False)
    fig.colorbar(
        mpl.cm.ScalarMappable(norm=Normalize(0, 1), cmap=cmap),
        cax=fig.add_axes([0.925, 0.17, 0.018, 0.70]),
        label="Feature value",
    )
    export(fig, output_stem)


if __name__ == "__main__":
    make_figure(ROOT / "outputs" / "attribution_polar_importance_replica")
