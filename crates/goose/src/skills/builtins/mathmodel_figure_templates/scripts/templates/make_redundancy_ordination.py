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


def redundancy_analysis(predictors, responses):
    x, y = np.asarray(predictors, float), np.asarray(responses, float)
    if (
        x.ndim != 2
        or y.ndim != 2
        or len(x) != len(y)
        or not np.isfinite(x).all()
        or not np.isfinite(y).all()
    ):
        raise ValueError("Use aligned finite predictor and response matrices")
    x = x - x.mean(0)
    y = y - y.mean(0)
    fitted = x @ np.linalg.lstsq(x, y, rcond=None)[0]
    u, s, v = np.linalg.svd(fitted, full_matrices=False)
    if len(s) < 2 or s[1] < 1e-10 or np.sum(y * y) == 0:
        raise ValueError("At least two nonzero constrained axes are needed")
    return u[:, :2] * s[:2], s * s / np.sum(y * y)


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


def make_figure(output_stem):
    configure()
    rng = np.random.default_rng(745)
    n = 64
    raw = rng.normal(size=(n, 10))
    sites = np.arange(n) % 4
    leaf = np.arange(n) % 2
    raw[:, 0] += (sites - 1.5) * 0.5
    y = raw @ rng.normal(size=(10, 5)) + rng.normal(0, 0.5, (n, 5))
    scores, ratio = redundancy_analysis(raw, y)
    scores = scores / scores.std(0) * 0.85
    fig, ax = plt.subplots(figsize=(6.7, 5.1))
    fig.subplots_adjust(left=0.13, right=0.72, bottom=0.14, top=0.92)
    palette = ["#ad8852", "#c5a86d", "#879484", "#c4cbbb"]
    sizes = 18 + 45 * (raw[:, 2] - raw[:, 2].min()) / np.ptp(raw[:, 2])
    for g in range(4):
        for l in range(2):
            z = (sites == g) & (leaf == l)
            ax.scatter(
                *scores[z].T,
                s=sizes[z],
                c=palette[g],
                marker=["o", "^"][l],
                edgecolors="white",
                lw=0.3,
                alpha=0.9,
            )
    names = [
        "Length",
        "Nitrogen",
        "Water",
        "Mass",
        "Density",
        "Area",
        "Height",
        "Carbon",
        "Rainfall",
        "Texture",
    ]
    for j, name in enumerate(names):
        v = (
            np.array([np.corrcoef(raw[:, j], scores[:, a])[0, 1] for a in (0, 1)])
            * 2.55
        )
        ax.annotate(
            "",
            xy=v,
            xytext=(0, 0),
            arrowprops=dict(arrowstyle="->", lw=0.6, color=".25"),
        )
        ax.text(
            *(v * 1.09),
            name,
            fontsize=6,
            ha="left" if v[0] > 0 else "right",
            va="center",
        )
    ax.set(
        xlim=(-3.2, 3.2),
        ylim=(-2.8, 3),
        xlabel=f"RDA1 ({ratio[0]:.1%})",
        ylabel=f"RDA2 ({ratio[1]:.1%})",
    )
    site = ax.legend(
        handles=[
            Line2D([], [], marker="o", ls="", c=c, label=f"Site {i + 1}", ms=5)
            for i, c in enumerate(palette)
        ],
        title="Site",
        bbox_to_anchor=(1.03, 1.03),
        loc="upper left",
        fontsize=6,
        title_fontsize=8,
    )
    ax.add_artist(site)
    typ = ax.legend(
        handles=[
            Line2D([], [], marker=m, ls="", c=".2", label=l, ms=4)
            for m, l in zip(["o", "^"], ["Type A", "Type B"])
        ],
        title="Sample type",
        bbox_to_anchor=(1.03, 0.63),
        loc="upper left",
        fontsize=6,
        title_fontsize=8,
    )
    ax.add_artist(typ)
    ax.legend(
        handles=[
            plt.scatter([], [], s=s, c=".2", label=l)
            for s, l in zip([18, 33, 48, 63], ["Low", "Moderate", "High", "Very high"])
        ],
        title="Measured trait",
        bbox_to_anchor=(1.03, 0.38),
        loc="upper left",
        labelspacing=0.9,
        fontsize=6,
        title_fontsize=8,
    )
    export(fig, output_stem)


if __name__ == "__main__":
    make_figure(ROOT / "outputs" / "redundancy_ordination_replica")
