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


from scipy.spatial.distance import pdist, squareform, squareform


def mantel_test(a, b, permutations=499, seed=656):
    a, b = np.asarray(a, float), np.asarray(b, float)
    if (
        a.shape != b.shape
        or a.ndim != 2
        or a.shape[0] != a.shape[1]
        or len(a) < 4
        or not np.isfinite(a).all()
        or not np.isfinite(b).all()
        or not np.allclose(a, a.T)
        or not np.allclose(b, b.T)
    ):
        raise ValueError("Provide two aligned finite symmetric distance matrices")
    lower = np.tril_indices(len(a), -1)
    observed = np.corrcoef(a[lower], b[lower])[0, 1]
    if not np.isfinite(observed) or permutations < 1:
        raise ValueError("Varying distances and positive permutation count required")
    rng = np.random.default_rng(seed)
    exceed = 0
    for _ in range(permutations):
        order = rng.permutation(len(a))
        coefficient = np.corrcoef(a[lower], b[np.ix_(order, order)][lower])[0, 1]
        exceed += abs(coefficient) >= abs(observed) - 1e-12
    return observed, (exceed + 1) / (permutations + 1)


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


def coefficient_cells(
    ax, r, p=None, labels=None, mode="lower", cmap="RdBu_r", glyph=False, text=True
):
    r = np.asarray(r)
    rows, cols = r.shape
    norm = Normalize(-1, 1)
    cmap = mpl.colormaps[cmap]
    for i in range(rows):
        for j in range(cols):
            if mode == "lower" and j >= i:
                continue
            value = r[i, j]
            ax.add_patch(
                Rectangle((j - 0.5, i - 0.5), 1, 1, fc="white", ec=".6", lw=0.35)
            )
            if glyph:
                side = 0.88 * np.sqrt(abs(value))
                ax.add_patch(
                    Rectangle(
                        (j - side / 2, i - side / 2),
                        side,
                        side,
                        fc=cmap(norm(value)),
                        ec="none",
                    )
                )
            else:
                ax.add_patch(
                    Rectangle(
                        (j - 0.5, i - 0.5),
                        1,
                        1,
                        fc=cmap(norm(value)),
                        ec="white",
                        lw=0.35,
                    )
                )
            if text:
                label = f"{value:.2f}"
                if p is not None:
                    label += "\n" + (
                        "***"
                        if p[i, j] < 0.001
                        else "**"
                        if p[i, j] < 0.01
                        else "*"
                        if p[i, j] < 0.05
                        else ""
                    )
                ax.text(
                    j,
                    i,
                    label,
                    ha="center",
                    va="center",
                    fontsize=5,
                    color="white" if abs(value) > 0.72 else ".2",
                )
    ax.set(xlim=(-0.5, cols - 0.5), ylim=(rows - 0.5, -0.5), aspect="equal")
    ax.set_xticks(
        range(cols),
        labels or [f"X{i + 1}" for i in range(cols)],
        rotation=65,
        ha="right",
    )
    ax.set_yticks(
        range(rows),
        labels
        if labels is not None and rows == cols
        else [f"V{i + 1}" for i in range(rows)],
    )
    ax.tick_params(length=0)
    for s in ax.spines.values():
        s.set_visible(False)
    return mpl.cm.ScalarMappable(norm=norm, cmap=cmap)


def correlation_pair(x):
    p = x.shape[1]
    r = np.corrcoef(x, rowvar=False)
    prob = np.ones((p, p))
    for i in range(p):
        for j in range(i):
            prob[i, j] = prob[j, i] = stats.pearsonr(x[:, i], x[:, j]).pvalue
    return r, prob


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
    x = matrix_demo(100, 18, 912)
    r, p = correlation_pair(x)
    fig, ax = plt.subplots(figsize=(9, 7.8))
    fig.subplots_adjust(left=0.15, right=0.96, top=0.93, bottom=0.16)
    m = coefficient_cells(ax, r, p, mode="lower", cmap="BrBG", glyph=True, text=False)
    # Connections encode distance-matrix association; example responses are measured sample blocks.
    from scipy.spatial.distance import pdist, squareform

    nodes = np.array([[11, -2], [15, 1], [19, 5], [23, 9]])
    for k, end in enumerate(nodes):
        block = pdist(x[:, k * 4 : k * 4 + 4])
        ax.scatter(*end, s=22, c="#579a87")
        ax.text(end[0] + 0.35, end[1], f"M{k + 1}", fontsize=7)
        for j in range(18):
            coefficient, probability = mantel_test(
                squareform(pdist(x[:, j : j + 1])),
                squareform(block),
                permutations=99,
                seed=58 + j + k * 18,
            )
            color = (
                "#439989"
                if probability <= 0.01
                else "#9caca5"
                if probability < 0.05
                else "#d1d1cc"
            )
            curve_edge(
                ax,
                (j, j - 0.55),
                end,
                color,
                lw=0.25 + abs(coefficient) * 1.6,
                alpha=0.7,
                bend=-0.12,
            )
            ax.scatter(j, j - 0.55, s=7, c="#739c92")
    legend = ax.legend(
        handles=[
            Line2D([], [], c=c, lw=1, label=l)
            for c, l in zip(
                ["#439989", "#9caca5", "#d1d1cc"],
                ["p ≤ .01", ".01 < p < .05", "p ≥ .05"],
            )
        ],
        title="Mantel permutation p",
        loc="upper left",
        fontsize=5,
        title_fontsize=6,
    )
    ax.add_artist(legend)
    ax.legend(
        handles=[
            Line2D([], [], c=".5", lw=0.25 + v * 1.6, label=str(v))
            for v in [0.2, 0.5, 0.8]
        ],
        title="|Mantel r|",
        loc="center left",
        fontsize=5,
        title_fontsize=6,
    )
    ax.set(xlim=(-1, 25), ylim=(18.5, -3))
    fig.colorbar(m, cax=fig.add_axes([0.08, 0.22, 0.02, 0.30]), label="Pearson r")
    export(fig, output_stem)


if __name__ == "__main__":
    make_figure(ROOT / "outputs" / "distance_association_network_replica")
