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


def pixel_coefficients(drivers, response):
    drivers, response = np.asarray(drivers, float), np.asarray(response, float)
    if (
        drivers.ndim != 4
        or response.shape != drivers.shape[:-1]
        or not np.isfinite(drivers).all()
        or not np.isfinite(response).all()
    ):
        raise ValueError(
            "Use aligned finite time-row-column-feature and time-row-column arrays"
        )
    dx = drivers.std(0, ddof=1)
    dy = response.std(0, ddof=1)
    if np.any(dx == 0) or np.any(dy == 0):
        raise ValueError("Remove constant time series before standardization")
    x = (drivers - drivers.mean(0)) / dx
    y = (response - response.mean(0)) / dy
    result = np.empty(drivers.shape[1:])
    for row in range(result.shape[0]):
        for column in range(result.shape[1]):
            result[row, column] = np.linalg.lstsq(
                x[:, row, column], y[:, row, column], rcond=None
            )[0]
    return result


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
    from scipy.ndimage import gaussian_filter

    rng = np.random.default_rng(860)
    n = 230
    y, x = np.mgrid[-1 : 1 : complex(n), -1 : 1 : complex(n)]
    scores = []
    for k in range(4):
        scores.append(
            gaussian_filter(rng.normal(size=(n, n)), 1.0)
            + 0.23 * np.sin(x * (4 + k) + y * 3 + k)
            + [0.15, 0.05, -0.05, -0.27][k]
        )
    dominant = np.argmax(scores, axis=0)
    palette = ["#2676a8", "#d64134", "#e284c5", "#22c5d0"]
    fig, ax = plt.subplots(figsize=(6.3, 6))
    fig.subplots_adjust(left=0.05, right=0.84, top=0.9, bottom=0.08)
    im = ax.imshow(
        dominant,
        cmap=ListedColormap(palette),
        norm=BoundaryNorm(np.arange(-0.5, 4.5), 4),
        interpolation="nearest",
    )
    ax.set_xticks([])
    ax.set_yticks([])
    ax.set_title("Dominant factor map")
    cb = fig.colorbar(im, cax=fig.add_axes([0.9, 0.19, 0.028, 0.61]), ticks=range(4))
    cb.set_ticklabels(["Vegetation", "Moisture", "Surface", "Water"])
    cb.set_label("Dominant factor")
    export(fig, output_stem)


if __name__ == "__main__":
    make_figure(ROOT / "outputs" / "pixel_regression_maps_replica")
