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


from scipy.spatial.distance import pdist, squareform


def principal_coordinates(distance):
    distance = np.asarray(distance, float)
    if (
        distance.ndim != 2
        or distance.shape[0] != distance.shape[1]
        or not np.isfinite(distance).all()
        or np.any(distance < 0)
        or not np.allclose(distance, distance.T)
        or not np.allclose(np.diag(distance), 0)
    ):
        raise ValueError(
            "Supply a finite symmetric nonnegative distance matrix with zero diagonal"
        )
    n = len(distance)
    center = np.eye(n) - np.ones((n, n)) / n
    gram = -0.5 * center @ (distance**2) @ center
    values, vectors = np.linalg.eigh(gram)
    order = np.argsort(values)[::-1]
    values = values[order]
    vectors = vectors[:, order]
    if np.sum(values > 1e-10) < 2:
        raise ValueError("Distance matrix has fewer than two positive coordinate axes")
    return vectors[:, :2] * np.sqrt(values[:2]), values


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


def density(ax, values, color, vertical=False, alpha=0.38, limits=None):
    values = np.asarray(values, float)
    grid = np.linspace(
        *(
            limits
            if limits is not None
            else (values.min() - values.std() * 0.6, values.max() + values.std() * 0.6)
        ),
        180,
    )
    y = stats.gaussian_kde(values)(grid)
    if vertical:
        ax.fill_betweenx(grid, 0, y, color=color, alpha=alpha, lw=0)
        ax.plot(y, grid, color=color, lw=0.65)
    else:
        ax.fill_between(grid, 0, y, color=color, alpha=alpha, lw=0)
        ax.plot(grid, y, color=color, lw=0.65)
    return grid, y


def margins(fig, spec, ratio=5):
    gs = spec.subgridspec(
        2,
        2,
        height_ratios=[1, ratio],
        width_ratios=[ratio, 1],
        hspace=0.025,
        wspace=0.025,
    )
    ax = fig.add_subplot(gs[1, 0])
    top = fig.add_subplot(gs[0, 0], sharex=ax)
    right = fig.add_subplot(gs[1, 1], sharey=ax)
    for a in (top, right):
        a.tick_params(left=False, bottom=False, labelleft=False, labelbottom=False)
        for s in a.spines.values():
            s.set_visible(False)
    return ax, top, right


def ellipse_region(ax, points, color):
    cov = np.cov(points.T)
    val, vec = np.linalg.eigh(cov)
    order = val.argsort()[::-1]
    val = val[order]
    vec = vec[:, order]
    angle = np.degrees(np.arctan2(vec[1, 0], vec[0, 0]))
    patch = Ellipse(
        points.mean(0),
        4 * np.sqrt(val[0]),
        4 * np.sqrt(val[1]),
        angle=angle,
        color=color,
        alpha=0.20,
        lw=0.6,
    )
    ax.add_patch(patch)


def make_figure(output_stem):
    configure()
    rng = np.random.default_rng(981)
    palette = ["#aa8263", "#9c9b82", "#dcc59b"]
    x, group = example_data(n=75, p=5, seed=942)
    points, eigenvalues = principal_coordinates(squareform(pdist(x)))
    points = points / 90
    ratio = eigenvalues[:2] / eigenvalues[eigenvalues > 0].sum()
    fig = plt.figure(figsize=(6.2, 5.3))
    outer = fig.add_gridspec(1, 1, left=0.13, right=0.97, bottom=0.16, top=0.97)
    ax, top, right = margins(fig, outer[0], ratio=4.5)
    for g, color in enumerate(palette):
        selected = points[group == g]
        ax.scatter(
            *selected.T,
            s=12,
            c=color,
            edgecolors="white",
            linewidths=0.25,
            label=["Group A", "Group B", "Group C"][g],
        )
        ellipse_region(ax, selected, color)
        density(top, selected[:, 0], color)
        density(right, selected[:, 1], color, vertical=True)
    ax.axhline(0, c=".7", ls="--", lw=0.4)
    ax.axvline(0, c=".7", ls="--", lw=0.4)
    ax.set(xlabel=f"PCoA1 ({ratio[0]:.1%})", ylabel=f"PCoA2 ({ratio[1]:.1%})")
    ax.legend(
        loc="upper right",
        fontsize=6,
        markerscale=0.8,
        handletextpad=0.1,
        labelspacing=0.25,
    )
    fig.text(
        0.13,
        0.05,
        "Ellipses: two standard deviations; distances from simulated samples",
        fontsize=6,
    )
    export(fig, output_stem)


if __name__ == "__main__":
    make_figure(ROOT / "outputs" / "principal_coordinate_map_replica")
