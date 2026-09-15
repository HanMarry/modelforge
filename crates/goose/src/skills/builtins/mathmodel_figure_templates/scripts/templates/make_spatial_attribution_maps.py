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


def spatial_sample():
    rng = np.random.default_rng(670)
    yy, xx = np.mgrid[-1:1:26j, -1:1:30j]
    time = np.arange(48)
    drivers = rng.normal(size=(48, 26, 30, 3))
    coefficients = np.stack(
        [0.9 + 0.5 * xx, -0.7 + 0.6 * yy, 0.3 + 0.7 * xx * yy], axis=-1
    )
    response = np.sum(drivers * coefficients[None, ...], axis=-1) + rng.normal(
        0, 0.35, (48, 26, 30)
    )
    mask = xx * xx + (yy / 1.1) ** 2 < 1
    return xx, yy, drivers, response, mask


def spatial_panel(fig, ax, values, mask, title, limit=None, cmap="RdBu_r"):
    data = np.where(mask, values, np.nan)
    if limit is None:
        limit = max(np.nanmax(np.abs(data)), 1e-9)
    image = ax.imshow(
        data, origin="lower", extent=[-1, 1, -1, 1], cmap=cmap, vmin=-limit, vmax=limit
    )
    ax.set(
        xlabel="Local X (arbitrary units)",
        ylabel="Local Y (arbitrary units)",
        title=title,
    )
    fig.colorbar(image, ax=ax, shrink=0.75, label="Value")
    return image


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
    rng = np.random.default_rng(858)
    ny, nx = 85, 110
    yy, xx = np.mgrid[-1 : 1 : complex(ny), -1.5 : 1.5 : complex(nx)]
    mask = ((xx + 0.15) ** 2 / 0.23 + (yy - 0.38) ** 2 / 0.15 < 1) | (
        (xx + 0.40) ** 2 / 0.12 + (yy + 0.12) ** 2 / 0.43 < 1
    )
    mask &= np.sin(xx * 25 + yy * 14) + rng.normal(size=(ny, nx)) > -2.5
    scores = np.stack(
        [
            0.6 + xx + 0.015 * rng.normal(size=(ny, nx)),
            0.5 + yy + 0.015 * rng.normal(size=(ny, nx)),
        ]
    )
    dominant = np.ma.array(np.argmax(scores, axis=0), mask=~mask)
    cmap = ListedColormap(["#267eae", "#1bc4cc"])
    cmap.set_bad("white")
    fig, ax = plt.subplots(figsize=(7.7, 5.2))
    fig.subplots_adjust(left=0.07, right=0.85, top=0.89, bottom=0.12)
    im = ax.imshow(
        dominant,
        cmap=cmap,
        norm=BoundaryNorm([-0.5, 0.5, 1.5], 2),
        interpolation="nearest",
    )
    ax.set_xticks([])
    ax.set_yticks([])
    ax.set_title("Dominant feature map")
    cb = fig.colorbar(im, cax=fig.add_axes([0.90, 0.19, 0.027, 0.62]), ticks=[0, 1])
    cb.set_ticklabels(["Feature A", "Feature B"])
    cb.set_label("Dominant feature")
    export(fig, output_stem)


if __name__ == "__main__":
    make_figure(ROOT / "outputs" / "spatial_attribution_maps_replica")
