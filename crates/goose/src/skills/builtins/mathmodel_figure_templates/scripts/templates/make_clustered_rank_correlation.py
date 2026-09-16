from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("MPLCONFIGDIR", str(ROOT / ".mplconfig"))

import matplotlib as mpl

mpl.use("Agg")

import matplotlib.pyplot as plt
import numpy as np

COLORS = ["#287C8E", "#D58B52", "#7774A6", "#668D62"]


def configure_matplotlib() -> None:
    mpl.rcParams.update(
        {
            "font.family": "DejaVu Sans",
            "font.size": 10,
            "axes.spines.top": False,
            "axes.spines.right": False,
            "axes.labelcolor": "#263742",
            "text.color": "#263742",
            "axes.prop_cycle": mpl.cycler(color=COLORS),
            "legend.frameon": False,
            "pdf.fonttype": 42,
            "svg.fonttype": "none",
        }
    )


from scipy.cluster.hierarchy import dendrogram, leaves_list, linkage
from scipy.spatial.distance import squareform
from scipy.stats import spearmanr


def clustered_correlation(
    values: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Cluster variables by signed Spearman distance 1-r using average linkage."""
    values = np.asarray(values, dtype=float)
    if values.ndim != 2 or values.shape[0] < 3 or values.shape[1] < 3:
        raise ValueError("Provide at least three samples and three features")
    if not np.isfinite(values).all() or np.any(np.ptp(values, axis=0) == 0):
        raise ValueError("Provide finite, nonconstant feature columns")
    corr = spearmanr(values, axis=0).statistic
    distance = np.clip(1 - corr, 0, 2)
    np.fill_diagonal(distance, 0)
    tree = linkage(
        squareform(distance, checks=False), method="average", optimal_ordering=True
    )
    return corr, tree, leaves_list(tree)


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
    from scipy.cluster.hierarchy import linkage, dendrogram

    rng = np.random.default_rng(776)
    data = matrix_demo(150, 38, 776)
    result = stats.spearmanr(data)
    r = result.statistic[:24, 24:]
    p = result.pvalue[:24, 24:]
    rt = linkage(r, method="average")
    ct = linkage(r.T, method="average")
    ri = dendrogram(rt, no_plot=True)["leaves"]
    ci = dendrogram(ct, no_plot=True)["leaves"]
    r = r[np.ix_(ri, ci)]
    p = p[np.ix_(ri, ci)]
    fig = plt.figure(figsize=(7.1, 8))
    gs = fig.add_gridspec(
        2,
        2,
        height_ratios=[1, 6],
        width_ratios=[1, 5],
        left=0.05,
        right=0.70,
        bottom=0.22,
        top=0.95,
        wspace=0.02,
        hspace=0.02,
    )
    top = fig.add_subplot(gs[0, 1])
    dendrogram(
        ct, ax=top, no_labels=True, color_threshold=0, above_threshold_color=".25"
    )
    top.axis("off")
    left = fig.add_subplot(gs[1, 0])
    dendrogram(
        rt,
        ax=left,
        orientation="left",
        no_labels=True,
        color_threshold=0,
        above_threshold_color=".25",
    )
    left.invert_yaxis()
    left.axis("off")
    ax = fig.add_subplot(gs[1, 1])
    im = ax.imshow(r, cmap="PuOr_r", vmin=-1, vmax=1, aspect="auto")
    ax.set_xticks(
        range(14), [f"Predictor {i + 1:02}" for i in ci], rotation=90, fontsize=6
    )
    ax.set_yticks(
        range(24), [f"Measured variable {i + 1:02}" for i in ri], fontsize=5.5
    )
    ax.yaxis.tick_right()
    ax.tick_params(length=0)
    ax.set_xticks(np.arange(-0.5, 14), minor=True)
    ax.set_yticks(np.arange(-0.5, 24), minor=True)
    ax.grid(which="minor", c="white", lw=0.3)
    ax.tick_params(which="minor", length=0)
    for i in range(24):
        for j in range(14):
            if p[i, j] < 0.05:
                ax.text(
                    j,
                    i,
                    "**" if p[i, j] < 0.01 else "*",
                    ha="center",
                    va="center",
                    fontsize=5,
                )
    fig.colorbar(im, cax=fig.add_axes([0.94, 0.56, 0.018, 0.27]), label="Spearman r")
    fig.text(0.91, 0.34, "* p < .05\n** p < .01", fontsize=5)
    export(fig, output_stem)


if __name__ == "__main__":
    make_figure(ROOT / "outputs" / "clustered_rank_correlation_replica")
