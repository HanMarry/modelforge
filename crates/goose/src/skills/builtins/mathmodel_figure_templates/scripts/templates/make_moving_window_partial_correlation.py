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


def partial_correlation(a, b, controls):
    a, b, controls = (
        np.asarray(a, float),
        np.asarray(b, float),
        np.asarray(controls, float),
    )
    if controls.ndim == 1:
        controls = controls[:, None]
    design = np.column_stack([np.ones(len(a)), controls])
    ra = a - design @ np.linalg.lstsq(design, a, rcond=None)[0]
    rb = b - design @ np.linalg.lstsq(design, b, rcond=None)[0]
    if len(a) <= design.shape[1] + 1 or np.std(ra) < 1e-12 or np.std(rb) < 1e-12:
        return np.nan
    return np.corrcoef(ra, rb)[0, 1]


def window_partial(a, b, control, radius=3):
    result = np.full(a.shape, np.nan)
    for row in range(a.shape[0]):
        for col in range(a.shape[1]):
            sl = (
                slice(max(0, row - radius), min(a.shape[0], row + radius + 1)),
                slice(max(0, col - radius), min(a.shape[1], col + radius + 1)),
            )
            x, y, z = a[sl].ravel(), b[sl].ravel(), control[sl].ravel()
            valid = np.isfinite(x) & np.isfinite(y) & np.isfinite(z)
            if valid.sum() >= 8:
                result[row, col] = partial_correlation(x[valid], y[valid], z[valid])
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

    rng = np.random.default_rng(844)
    ny, nx, t = 60, 64, 260
    yy, xx = np.mgrid[-1 : 1 : complex(ny), -1 : 1 : complex(nx)]
    base = gaussian_filter(rng.normal(size=(ny, nx)), 4)
    beta = -0.35 + 0.17 * base / np.ptp(base)
    control = rng.normal(size=(t, ny, nx))
    a = rng.normal(size=(t, ny, nx)) + 0.5 * control
    b = beta[None, :, :] * a + 0.4 * control + rng.normal(0, 0.6, (t, ny, nx))
    ac = a - a.mean(0)
    bc = b - b.mean(0)
    cc = control - control.mean(0)
    ra = ac - cc * (np.sum(ac * cc, axis=0) / np.sum(cc * cc, axis=0))
    rb = bc - cc * (np.sum(bc * cc, axis=0) / np.sum(cc * cc, axis=0))
    correlation = np.sum(ra * rb, axis=0) / np.sqrt(
        np.sum(ra * ra, axis=0) * np.sum(rb * rb, axis=0)
    )
    fig, ax = plt.subplots(figsize=(6.1, 5.8))
    fig.subplots_adjust(left=0.07, right=0.84, top=0.9, bottom=0.08)
    im = ax.imshow(correlation, cmap="RdBu_r", vmin=-1, vmax=1, interpolation="nearest")
    ax.set_xticks([])
    ax.set_yticks([])
    ax.set_title("Partial correlation: response vs. predictor")
    fig.colorbar(im, cax=fig.add_axes([0.90, 0.18, 0.028, 0.65]), label="Partial r")
    export(fig, output_stem)


if __name__ == "__main__":
    make_figure(ROOT / "outputs" / "moving_window_partial_correlation_replica")
