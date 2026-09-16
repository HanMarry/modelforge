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


def configure():
    mpl.rcParams.update(
        {
            "font.family": "DejaVu Sans",
            "font.size": 9,
            "axes.spines.top": False,
            "axes.spines.right": False,
            "axes.prop_cycle": mpl.cycler(color=COLORS),
            "legend.frameon": False,
            "axes.titlesize": 11,
            "pdf.fonttype": 42,
            "svg.fonttype": "none",
        }
    )


def export(fig, output_stem):
    fig.supxlabel("Deterministic demonstration data", fontsize=8, color="#68757D")
    output_stem.parent.mkdir(parents=True, exist_ok=True)
    for suffix in (".png", ".pdf", ".svg"):
        fig.savefig(output_stem.with_suffix(suffix), dpi=300, bbox_inches="tight")
    plt.close(fig)


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


def make_figure(output_stem):
    configure()
    x, phi, _, prediction = attribution_data()
    order = np.argsort(np.mean(np.abs(phi), axis=0))[::-1]
    samples = np.argsort(prediction)
    fig = plt.figure(figsize=(10.5, 6.5), layout="constrained")
    grid = fig.add_gridspec(2, 2, height_ratios=[1, 3], width_ratios=[5, 1.5])
    top = fig.add_subplot(grid[0, 0])
    heat = fig.add_subplot(grid[1, 0])
    bars = fig.add_subplot(grid[1, 1], sharey=heat)
    top.plot(prediction[samples], color=COLORS[0], lw=1.5)
    top.set(
        ylabel="Prediction", title="Analytic-model attributions ordered by prediction"
    )
    limit = np.quantile(np.abs(phi), 0.99)
    im = heat.imshow(
        phi[samples][:, order].T, aspect="auto", cmap="RdBu_r", vmin=-limit, vmax=limit
    )
    heat.set(
        xlabel="Samples ordered by prediction",
        yticks=range(6),
        yticklabels=[f"F{i + 1}" for i in order],
    )
    bars.barh(range(6), np.mean(np.abs(phi), axis=0)[order], color=COLORS[0])
    bars.set(xlabel="Mean |contribution|")
    bars.tick_params(labelleft=False)
    fig.colorbar(im, ax=[heat, bars], shrink=0.7, label="Contribution")
    export(fig, output_stem)


if __name__ == "__main__":
    make_figure(ROOT / "outputs" / "attribution_matrix_summary_replica")
