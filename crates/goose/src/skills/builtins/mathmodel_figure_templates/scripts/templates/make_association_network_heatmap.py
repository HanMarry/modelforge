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
    fig = plt.figure(figsize=(8, 8))
    root = fig.add_axes([0.04, 0.08, 0.88, 0.86])
    root.set(xlim=(0, 1), ylim=(0, 1))
    root.axis("off")
    positions = [
        (0.03, 0.58, 0.36, 0.36),
        (0.60, 0.58, 0.36, 0.36),
        (0.03, 0.03, 0.36, 0.36),
    ]
    palette = ["#cf6c68", "#d7b96e", "#75b4b4"]
    rng = np.random.default_rng(998)
    for g, (x0, y0, w, h) in enumerate(positions):
        x = matrix_demo(90, 6, 732 + g)
        r, p = correlation_pair(x)
        ax = root.inset_axes([x0, y0, w, h])
        m = coefficient_cells(ax, r, p, mode="lower", cmap="RdYlGn", text=True)
        ax.invert_yaxis() if g == 0 else ax.invert_xaxis() if g == 1 else None
        ax.tick_params(labelsize=5)
        ax.set_title(f"Group {g + 1}", fontsize=7)
        for j in range(6):
            point = (x0 + w * (j + 0.5) / 6, y0 + h * (1 - (j + 0.5) / 6))
            curve_edge(
                root,
                point,
                (0.5, 0.5),
                palette[g],
                lw=0.35 + 0.65 * abs(r[0, j]),
                alpha=0.25,
                bend=0.08,
            )
    root.scatter(0.5, 0.5, s=530, c="#76acc9", zorder=9)
    root.text(
        0.5, 0.5, "Response", ha="center", va="center", c="white", fontsize=7, zorder=10
    )
    root.legend(
        handles=[
            Line2D([], [], c=c, label=f"Group {i + 1}") for i, c in enumerate(palette)
        ],
        loc="lower right",
        bbox_to_anchor=(0.93, 0.06),
        title="Association network",
        fontsize=6,
        title_fontsize=7,
    )
    fig.colorbar(m, cax=fig.add_axes([0.94, 0.22, 0.022, 0.36]), label="r")
    export(fig, output_stem)


if __name__ == "__main__":
    make_figure(ROOT / "outputs" / "association_network_heatmap_replica")
