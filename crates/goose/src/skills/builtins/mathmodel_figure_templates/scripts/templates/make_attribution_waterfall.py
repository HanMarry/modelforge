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


def make_figure(output_stem):
    configure()
    rng = np.random.default_rng(944)
    features = 10
    value = rng.uniform(0.3, 1.4, size=features)
    value[[3, 7]] *= -1
    contrib = value * np.geomspace(0.25, 0.01, features)
    order = np.argsort(abs(contrib))[::-1]
    contrib = contrib[order]
    baseline = 0.10
    fig, ax = plt.subplots(figsize=(8, 5.8))
    fig.subplots_adjust(left=0.32, right=0.94, bottom=0.17, top=0.88)
    running = baseline
    # Starting at the baseline, the bars terminate at the exact sum of contributions.
    for row in range(features - 1, -1, -1):
        delta = contrib[row]
        end = running + delta
        lo = min(running, end)
        width = abs(delta)
        color = "#fb005b" if delta >= 0 else "#098af1"
        direction = 1 if delta >= 0 else -1
        tip = min(width * 0.30, 0.035)
        verts = [
            (running, row - 0.32),
            (end - direction * tip, row - 0.32),
            (end, row),
            (end - direction * tip, row + 0.32),
            (running, row + 0.32),
        ]
        ax.add_patch(Polygon(verts, fc=color, ec="none"))
        ax.text(
            (running + end) / 2,
            row,
            f"{delta:+.2f}",
            ha="center",
            va="center",
            c="white",
            fontsize=7,
        )
        ax.plot([end, end], [row - 0.35, row - 1 + 0.32], c=".75", ls="--", lw=0.5)
        running = end
    ax.set_yticks(
        range(features),
        [f"{value[j]:.2f} = Feature {j + 1}" for j in order],
        fontsize=7,
    )
    ax.set_ylim(features - 0.5, -0.8)
    ax.set_xlim(min(baseline, running) - 0.08, max(baseline, running) + 0.08)
    ax.set_xlabel("Model output")
    ax.axvline(baseline, c=".7", lw=0.5)
    ax.text(
        baseline, features + 0.2, f"E[f(X)] = {baseline:.2f}", ha="center", fontsize=7
    )
    ax.text(running, -0.5, f"f(x) = {running:.2f}", ha="center", fontsize=8)
    ax.spines[["top", "right", "left"]].set_visible(False)
    export(fig, output_stem)


if __name__ == "__main__":
    make_figure(ROOT / "outputs" / "attribution_waterfall_replica")
