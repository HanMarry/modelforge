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


def example_data(n=150, p=6, seed=610):
    rng = np.random.default_rng(seed)
    group = np.arange(n) % 3
    latent = rng.normal(size=(n, 3))
    latent[:, 0] += (group - 1) * 0.8
    weights = rng.normal(size=(3, p))
    x = latent @ weights + rng.normal(0, 0.5, (n, p))
    x = (x - x.mean(0)) / x.std(0, ddof=1)
    return x, group


def correlation_statistics(x):
    x = np.asarray(x, float)
    if (
        x.ndim != 2
        or len(x) < 4
        or not np.isfinite(x).all()
        or np.any(np.ptp(x, axis=0) == 0)
    ):
        raise ValueError(
            "Use finite nonconstant feature columns with at least four rows"
        )
    p = x.shape[1]
    r, prob = np.eye(p), np.zeros((p, p))
    for i in range(p):
        for j in range(i):
            result = stats.pearsonr(x[:, i], x[:, j])
            r[i, j] = r[j, i] = result.statistic
            prob[i, j] = prob[j, i] = result.pvalue
    return r, prob


def adjust_fdr(probabilities):
    probabilities = np.asarray(probabilities, float)
    if (
        probabilities.ndim != 1
        or not np.isfinite(probabilities).all()
        or np.any((probabilities < 0) | (probabilities > 1))
    ):
        raise ValueError("FDR requires a one-dimensional array of p values in [0, 1]")
    if len(probabilities) == 0:
        return probabilities.copy()
    order = np.argsort(probabilities)
    ranked = probabilities[order] * len(order) / np.arange(1, len(order) + 1)
    corrected = np.minimum.accumulate(ranked[::-1])[::-1].clip(0, 1)
    result = np.empty_like(corrected)
    result[order] = corrected
    return result


def heatmap(ax, matrix, labels=None, title="Association", annotate=True):
    matrix = np.asarray(matrix)
    p = len(matrix)
    im = ax.imshow(matrix, vmin=-1, vmax=1, cmap="RdBu_r", aspect="equal")
    labels = labels if labels is not None else [f"F{i + 1}" for i in range(p)]
    ax.set(
        xticks=np.arange(p),
        yticks=np.arange(p),
        xticklabels=labels,
        yticklabels=labels,
        title=title,
    )
    if annotate:
        for i in range(p):
            for j in range(matrix.shape[1]):
                ax.text(
                    j,
                    i,
                    f"{matrix[i, j]:.2f}",
                    ha="center",
                    va="center",
                    fontsize=7,
                    color="white" if abs(matrix[i, j]) > 0.65 else "#263742",
                )
    return im


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


def linear_fit(x, y, grid=None):
    x, y = np.asarray(x, float), np.asarray(y, float)
    if (
        x.ndim != 1
        or x.shape != y.shape
        or len(x) < 4
        or not np.isfinite(x).all()
        or not np.isfinite(y).all()
        or np.ptp(x) == 0
    ):
        raise ValueError("Regression requires matching finite vectors and varying x")
    design = np.column_stack([np.ones(len(x)), x])
    beta = np.linalg.lstsq(design, y, rcond=None)[0]
    residual = y - design @ beta
    variance = residual @ residual / (len(x) - 2)
    grid = np.linspace(x.min(), x.max(), 100) if grid is None else np.asarray(grid)
    target = np.column_stack([np.ones(len(grid)), grid])
    fitted = target @ beta
    se = np.sqrt(
        np.maximum(
            0,
            variance
            * np.einsum(
                "ij,jk,ik->i", target, np.linalg.inv(design.T @ design), target
            ),
        )
    )
    interval = stats.t.ppf(0.975, len(x) - 2) * se
    return grid, fitted, interval, beta, residual


def regression_panel(ax, x, y, color=COLORS[0], label=None):
    grid, fitted, interval, beta, residual = linear_fit(x, y)
    ax.scatter(x, y, s=15, alpha=0.55, color=color, label=label)
    ax.plot(grid, fitted, color=color, lw=1.6)
    ax.fill_between(grid, fitted - interval, fitted + interval, color=color, alpha=0.14)
    return beta


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


def curve_edge(ax, start, end, color, lw=0.6, alpha=0.3, bend=0.25):
    start = np.array(start)
    end = np.array(end)
    delta = end - start
    normal = np.array([-delta[1], delta[0]])
    mid = (start + end) / 2 + bend * normal
    path = MplPath([start, mid, end], [MplPath.MOVETO, MplPath.CURVE3, MplPath.CURVE3])
    ax.add_patch(PathPatch(path, fc="none", ec=color, lw=lw, alpha=alpha))


def make_figure(output_stem):
    configure()
    rng = np.random.default_rng(996)
    x = matrix_demo(120, 5, 883)
    groups = np.arange(len(x)) % 4
    palette = ["#d9989a", "#a7c7a0", "#e0d48e", "#9dbdce"]
    fig = plt.figure(figsize=(10.2, 7.2))
    gs = fig.add_gridspec(
        5, 5, left=0.37, right=0.97, bottom=0.14, top=0.90, wspace=0.12, hspace=0.12
    )
    positions = []
    for i in range(5):
        for j in range(i, 5):
            ax = fig.add_subplot(gs[i, j])
            if i == j:
                ax.text(
                    0.5,
                    0.5,
                    f"Factor {i + 1}",
                    ha="center",
                    va="center",
                    transform=ax.transAxes,
                    fontsize=7,
                )
                ax.set_xticks([])
                ax.set_yticks([])
                positions.append(ax.get_position().bounds)
            else:
                for g, c in enumerate(palette):
                    z = groups == g
                    ax.scatter(x[z, j], x[z, i], s=3, c=c, alpha=0.55, lw=0)
                fit = stats.linregress(x[:, j], x[:, i])
                ends = np.array([x[:, j].min(), x[:, j].max()])
                ax.plot(ends, fit.intercept + fit.slope * ends, c=".3", lw=0.6)
                ax.tick_params(labelsize=4, length=1.5)
    net = fig.add_axes([0.04, 0.14, 0.9, 0.76], zorder=-1)
    net.set(xlim=(0, 1), ylim=(0, 1))
    net.axis("off")
    nodes = [(0.10, 0.55), (0.27, 0.8), (0.28, 0.19)]
    for k, node in enumerate(nodes):
        net.scatter(*node, s=26, c="#8d9eac")
        net.text(node[0] - 0.03, node[1], f"M{k + 1}", ha="right", fontsize=6)
        for j, bounds in enumerate(positions):
            end = (
                (bounds[0] + bounds[2] / 2 - 0.04) / 0.9,
                (bounds[1] + bounds[3] / 2 - 0.14) / 0.76,
            )
            curve_edge(
                net,
                node,
                end,
                ["#a5bac7", "#d3a9ac", "#b5c9b6"][j % 3],
                lw=0.35 + abs(np.corrcoef(x[:, k % 5], x[:, j])[0, 1]),
                alpha=0.28,
                bend=-0.07,
            )
    legend = fig.add_axes([0.05, 0.72, 0.20, 0.20])
    legend.axis("off")
    legend.legend(
        handles=[
            Line2D([], [], marker="o", ls="", c=c, label=f"Site {i + 1}", ms=4)
            for i, c in enumerate(palette)
        ],
        title="Site",
        loc="upper left",
        fontsize=6,
        title_fontsize=7,
    )
    export(fig, output_stem)


if __name__ == "__main__":
    make_figure(ROOT / "outputs" / "scatter_network_report_replica")
