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


from matplotlib.colors import LinearSegmentedColormap, ListedColormap, BoundaryNorm
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


def correlation_pair(x):
    p = x.shape[1]
    r = np.corrcoef(x, rowvar=False)
    prob = np.ones((p, p))
    for i in range(p):
        for j in range(i):
            prob[i, j] = prob[j, i] = stats.pearsonr(x[:, i], x[:, j]).pvalue
    return r, prob


def make_figure(output_stem):
    configure()
    rng = np.random.default_rng(910)
    data = rng.normal(size=(180, 66))
    data[:, :26] += 0.8 * data[:, 40:]
    r, p = correlation_pair(data)
    r = r[:40, 40:]
    prob = p[:40, 40:]
    weight = rng.uniform(0.035, 0.060, 26)
    fig = plt.figure(figsize=(7.2, 10))
    gs = fig.add_gridspec(
        2,
        1,
        height_ratios=[1, 8],
        left=0.22,
        right=0.85,
        top=0.94,
        bottom=0.18,
        hspace=0.025,
    )
    top = fig.add_subplot(gs[0])
    top.bar(range(26), weight, color="#d9df72", edgecolor=".5", lw=0.3, width=0.7)
    top.set_xlim(-0.5, 25.5)
    top.tick_params(labelbottom=False, labelsize=5)
    top.set_ylabel("Importance", fontsize=6)
    ax = fig.add_subplot(gs[1])
    norm = Normalize(-1, 1)
    cmap = mpl.colormaps["BrBG"]
    for i in range(40):
        for j in range(26):
            ax.add_patch(
                Rectangle((j - 0.5, i - 0.5), 1, 1, fc="white", ec=".75", lw=0.25)
            )
            if prob[i, j] < 0.05:
                ax.scatter(j, i, s=28 * abs(r[i, j]), c=[cmap(norm(r[i, j]))], lw=0)
    ax.set(xlim=(-0.5, 25.5), ylim=(39.5, -0.5), aspect="equal")
    ax.set_xticks(
        range(26), [f"Feature {i + 1}" for i in range(26)], rotation=90, fontsize=4.5
    )
    ax.set_yticks(
        range(40), [f"Observed variable {i + 1}" for i in range(40)], fontsize=4.5
    )
    ax.tick_params(length=0)
    fig.colorbar(
        mpl.cm.ScalarMappable(norm=norm, cmap=cmap),
        cax=fig.add_axes([0.90, 0.48, 0.018, 0.27]),
        label="Pearson r",
    )
    ax.legend(
        handles=[
            plt.scatter([], [], s=28 * v, c=".4", label=str(v)) for v in [0.2, 0.5, 0.8]
        ],
        title="|r|",
        loc="center left",
        bbox_to_anchor=(1.06, 0.30),
        fontsize=5,
        title_fontsize=6,
    )
    export(fig, output_stem)


if __name__ == "__main__":
    make_figure(ROOT / "outputs" / "importance_association_report_replica")
