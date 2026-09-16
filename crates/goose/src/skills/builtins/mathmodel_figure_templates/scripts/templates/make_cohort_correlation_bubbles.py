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
    rng = np.random.default_rng(966)
    n = 20
    values = np.zeros((4, n))
    prob = np.ones_like(values)
    for i in range(4):
        target = rng.normal(size=100)
        weights = rng.uniform(-0.5, 0.5, n)
        data = target[:, None] * weights + rng.normal(size=(100, n))
        for j in range(n):
            values[i, j], prob[i, j] = stats.pearsonr(target, data[:, j])
    fig, ax = plt.subplots(figsize=(10, 4.7))
    fig.subplots_adjust(left=0.12, right=0.79, bottom=0.29, top=0.9)
    palette = ["#24619c", "#87b1d5", "#d8e5f2", "#edd4d5", "#ce858e", "#a33646"]
    for i in range(4):
        ax.axhline(i, c=".75", lw=0.5)
        for j in range(n):
            level = 0 if prob[i, j] < 0.01 else 1 if prob[i, j] < 0.05 else 2
            idx = level if values[i, j] < 0 else 5 - level
            ax.scatter(j, i, s=5 + 85 * abs(values[i, j]), c=palette[idx], ec="none")
    ax.set(xlim=(-0.6, n - 0.4), ylim=(3.6, -0.6))
    ax.set_xticks(
        range(n),
        [f"Factor {i + 1}" for i in range(n)],
        rotation=50,
        ha="right",
        fontsize=6,
    )
    ax.set_yticks(range(4), ["Overall", "Region I", "Region II", "Region III"])
    ax.spines[["top", "right"]].set_visible(False)
    legend = ax.legend(
        handles=[
            plt.scatter(
                [], [], s=5 + 85 * v, fc="none", ec=".4", lw=0.5, label=f"{v:.1f}"
            )
            for v in [0.2, 0.4, 0.6, 0.8]
        ],
        title="|Correlation|",
        bbox_to_anchor=(1.03, 1.03),
        loc="upper left",
        fontsize=6,
        title_fontsize=7,
        labelspacing=0.7,
    )
    ax.add_artist(legend)
    ax.legend(
        handles=[
            Rectangle((0, 0), 1, 1, fc=c, label=l)
            for c, l in zip(
                palette,
                [
                    "Negative p < .01",
                    "Negative p < .05",
                    "Negative p ≥ .05",
                    "Positive p ≥ .05",
                    "Positive p < .05",
                    "Positive p < .01",
                ],
            )
        ],
        loc="upper left",
        bbox_to_anchor=(1.03, 0.40),
        fontsize=5.5,
    )
    export(fig, output_stem)


if __name__ == "__main__":
    make_figure(ROOT / "outputs" / "cohort_correlation_bubbles_replica")
