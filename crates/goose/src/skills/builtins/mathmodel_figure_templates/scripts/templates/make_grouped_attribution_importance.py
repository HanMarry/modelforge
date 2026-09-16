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
    x, phi = contribution_sample(n=400, p=17, seed=942)
    phi = x * np.r_[0.9, 0.4, 0.14, np.geomspace(0.012, 0.001, 14)]
    order = np.argsort(np.mean(abs(phi), axis=0))[::-1]
    groups = np.arange(17) % 3
    palette = ["#e5bf6d", "#a6bb91", "#d7b6d1"]
    fig = plt.figure(figsize=(10.2, 6.2))
    gs = fig.add_gridspec(
        1,
        2,
        width_ratios=[1, 2.7],
        left=0.14,
        right=0.97,
        top=0.89,
        bottom=0.24,
        wspace=0.025,
    )
    left = fig.add_subplot(gs[0])
    right = fig.add_subplot(gs[1])
    mean = np.mean(abs(phi), axis=0)[order]
    left.set_facecolor("#fffbec")
    right.set_facecolor("#fffbec")
    left.barh(range(17), mean, color=[palette[groups[i]] for i in order], height=0.72)
    for i, v in enumerate(mean):
        left.text(v + 0.006, i, f"{v:.2f}", fontsize=5, va="center")
    left.set_yticks(range(17), [f"Feature {i + 1}" for i in order], fontsize=6)
    left.invert_yaxis()
    left.set_xlabel("Mean |SHAP value|", fontsize=7)
    left.spines[["top", "right"]].set_visible(False)
    swarm_rows(right, x, phi, labels=[""] * 17, cmap="summer", order=order)
    right.set_ylim(16.6, -0.7)
    right.tick_params(axis="y", length=0)
    right.spines[["top", "right", "left"]].set_visible(False)
    right.set_xlabel("SHAP value (impact on model output)", fontsize=7)
    fig.patches.append(
        Rectangle(
            (0.135, 0.91),
            0.835,
            0.062,
            transform=fig.transFigure,
            fc="#f7ddb0",
            ec="none",
        )
    )
    fig.text(
        0.55,
        0.94,
        "Activity quality",
        ha="center",
        fontsize=11,
        bbox=dict(fc="#f7ddb0", ec="none", pad=7),
    )
    cb = fig.colorbar(
        mpl.cm.ScalarMappable(norm=Normalize(0, 1), cmap="summer"),
        cax=fig.add_axes([0.18, 0.135, 0.72, 0.023]),
        orientation="horizontal",
    )
    cb.set_ticks([0, 1], labels=["Low", "High"])
    cb.set_label("Feature value", fontsize=7)
    fig.legend(
        handles=[
            Rectangle((0, 0), 1, 1, fc=c, label=l)
            for c, l in zip(
                palette,
                ["Equity indicators", "Quality indicators", "Regulatory indicators"],
            )
        ],
        loc="lower center",
        bbox_to_anchor=(0.54, 0.05),
        ncol=3,
        fontsize=7,
    )
    export(fig, output_stem)


if __name__ == "__main__":
    make_figure(ROOT / "outputs" / "grouped_attribution_importance_replica")
