from __future__ import annotations

import json
import os
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("MPLCONFIGDIR", str(ROOT / ".mplconfig"))

import matplotlib as mpl

mpl.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.collections import LineCollection
from matplotlib.colors import BoundaryNorm, ListedColormap
from matplotlib.patches import Patch, Rectangle
from matplotlib.path import Path as MplPath
import numpy as np
from scipy.ndimage import gaussian_filter


BOUNDARY_FILE = ROOT / "data" / "ganjiang_upstream_basin_boundary.json"
YEARS = [1990, 2000, 2010, 2020]
CLASS_NAMES = ["Low ESV Zone", "Lower ESV Zone", "Central ESV Zone",
               "Higher ESV Zone", "High ESV Zone"]
CLASS_COLORS = ["#0872E8", "#D6BDE8", "#75E8E2", "#FFFDB2", "#FF1748"]
CMAP = ListedColormap(CLASS_COLORS)
NORM = BoundaryNorm(np.arange(-0.5, 5.5, 1), CMAP.N)


def configure_matplotlib() -> None:
    mpl.rcParams.update({
        "font.family": "sans-serif",
        "font.sans-serif": ["Arial", "Helvetica", "DejaVu Sans", "sans-serif"],
        "font.size": 8,
        "svg.fonttype": "none",
        "pdf.fonttype": 42,
    })


def load_boundary() -> tuple[list[np.ndarray], list[tuple[str, list[np.ndarray]]], tuple[float, float, float, float]]:
    payload = json.loads(BOUNDARY_FILE.read_text(encoding="utf-8"))
    outline = [np.asarray(ring, dtype=float) for ring in payload["outline"]]
    counties = [
        (county["name"], [np.asarray(ring, dtype=float) for ring in county["rings"]])
        for county in payload["counties"]
    ]
    return outline, counties, tuple(payload["bounds"])


def make_grid(outline: list[np.ndarray], bounds: tuple[float, float, float, float],
              nx: int = 42, ny: int = 41) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    xmin, ymin, xmax, ymax = bounds
    x_edges = np.linspace(xmin, xmax, nx + 1)
    y_edges = np.linspace(ymin, ymax, ny + 1)
    x = (x_edges[:-1] + x_edges[1:]) / 2
    y = (y_edges[:-1] + y_edges[1:]) / 2
    xx, yy = np.meshgrid(x, y)
    points = np.c_[xx.ravel(), yy.ravel()]
    mask = np.zeros(points.shape[0], dtype=bool)
    for ring in outline:
        mask |= MplPath(ring).contains_points(points)
    return x_edges, y_edges, xx, yy, mask.reshape(ny, nx)


def gaussian(x: np.ndarray, y: np.ndarray, cx: float, cy: float,
             sx: float, sy: float) -> np.ndarray:
    return np.exp(-0.5 * (((x - cx) / sx) ** 2 + ((y - cy) / sy) ** 2))


def simulate_esv(outline: list[np.ndarray], bounds: tuple[float, float, float, float]) -> tuple[np.ndarray, np.ndarray, list[np.ndarray], np.ndarray]:
    """Deterministic visual reconstruction; values are not study measurements."""
    x_edges, y_edges, xx, yy, mask = make_grid(outline, bounds)
    xn = (xx - x_edges[0]) / (x_edges[-1] - x_edges[0])
    yn = (yy - y_edges[0]) / (y_edges[-1] - y_edges[0])
    rng = np.random.default_rng(164084006)
    smooth = gaussian_filter(rng.normal(size=xx.shape), 2.2)
    smooth = (smooth - smooth.mean()) / smooth.std()
    speckle = rng.normal(size=xx.shape)

    positive = (
        1.35 * gaussian(xn, yn, 0.16, 0.51, 0.09, 0.11)
        + 1.05 * gaussian(xn, yn, 0.39, 0.60, 0.07, 0.12)
        + 1.10 * gaussian(xn, yn, 0.58, 0.67, 0.075, 0.10)
        + 0.90 * gaussian(xn, yn, 0.78, 0.78, 0.06, 0.13)
    )
    negative = (
        1.15 * gaussian(xn, yn, 0.32, 0.38, 0.09, 0.10)
        + 0.95 * gaussian(xn, yn, 0.55, 0.41, 0.075, 0.12)
        + 0.82 * gaussian(xn, yn, 0.78, 0.55, 0.07, 0.08)
    )
    base = 0.72 * positive - 0.68 * negative + 0.31 * smooth + 0.34 * speckle
    thresholds = np.quantile(base[mask], [0.075, 0.21, 0.47, 0.90])

    fields: list[np.ndarray] = []
    for index, _year in enumerate(YEARS):
        drift = 0.10 * index * gaussian(xn, yn, 0.58, 0.65, 0.14, 0.16)
        drift -= 0.055 * index * gaussian(xn, yn, 0.31, 0.38, 0.13, 0.13)
        jitter = gaussian_filter(rng.normal(size=xx.shape), 1.1) * 0.035
        values = base + drift + jitter
        classes = np.digitize(values, thresholds).astype(float)
        classes[~mask] = np.nan
        fields.append(classes)
    return x_edges, y_edges, fields, mask


def draw_boundaries(ax: plt.Axes, outline: list[np.ndarray],
                    counties: list[tuple[str, list[np.ndarray]]]) -> None:
    for _name, rings in counties:
        for ring in rings:
            ax.plot(ring[:, 0], ring[:, 1], color="#66747C", lw=0.32, zorder=4)
    for ring in outline:
        ax.plot(ring[:, 0], ring[:, 1], color="#3E4D55", lw=0.62, zorder=5)


def draw_cell_grid(ax: plt.Axes, x_edges: np.ndarray, y_edges: np.ndarray,
                   valid: np.ndarray) -> None:
    segments = []
    for row, col in np.argwhere(valid):
        x0, x1 = x_edges[col], x_edges[col + 1]
        y0, y1 = y_edges[row], y_edges[row + 1]
        segments.extend([[(x0, y0), (x1, y0)], [(x1, y0), (x1, y1)],
                         [(x1, y1), (x0, y1)], [(x0, y1), (x0, y0)]])
    ax.add_collection(LineCollection(segments, colors="#789198", linewidths=0.20,
                                     alpha=0.72, zorder=3))


def draw_scale_bar(ax: plt.Axes) -> None:
    x0, y0, width, height = 0.055, -0.085, 0.46, 0.019
    for idx in range(4):
        ax.add_patch(Rectangle((x0 + idx * width / 4, y0), width / 4, height,
                               transform=ax.transAxes, clip_on=False,
                               facecolor="#101010" if idx % 2 == 0 else "white",
                               edgecolor="#111111", lw=0.45))
    for pos, label in zip([0, 0.25, 0.50, 1], ["0", "30", "60", "120 km"]):
        ax.text(x0 + pos * width, y0 + height + 0.008, label,
                transform=ax.transAxes, ha="center", va="bottom", fontsize=6.8)


def draw_north_arrow(ax: plt.Axes) -> None:
    x, y = 0.87, 0.93
    ax.annotate("", xy=(x, y + 0.055), xytext=(x, y - 0.055),
                xycoords="axes fraction", arrowprops=dict(arrowstyle="-|>", lw=0.75, color="#111111"))
    ax.annotate("", xy=(x + 0.045, y), xytext=(x - 0.045, y),
                xycoords="axes fraction", arrowprops=dict(arrowstyle="-|>", lw=0.58, color="#111111"))
    ax.text(x, y + 0.064, "N", transform=ax.transAxes, ha="center", va="bottom", fontsize=5.2)
    ax.text(x, y - 0.064, "S", transform=ax.transAxes, ha="center", va="top", fontsize=5.0)
    ax.text(x - 0.051, y, "W", transform=ax.transAxes, ha="right", va="center", fontsize=5.0)
    ax.text(x + 0.051, y, "E", transform=ax.transAxes, ha="left", va="center", fontsize=5.0)


def add_legend(ax: plt.Axes) -> None:
    handles = [Patch(facecolor=color, edgecolor="#8A8A8A", lw=0.25, label=label)
               for label, color in zip(CLASS_NAMES, CLASS_COLORS)]
    legend = ax.legend(handles=handles, title="Legend", loc="lower right",
                       bbox_to_anchor=(1.03, -0.015), frameon=False,
                       fontsize=7.1, title_fontsize=8.0, borderaxespad=0,
                       labelspacing=0.30, handlelength=2.0, handleheight=1.05)
    legend.get_title().set_fontweight("bold")


def make_figure(output_stem: Path) -> None:
    configure_matplotlib()
    outline, counties, bounds = load_boundary()
    x_edges, y_edges, fields, _mask = simulate_esv(outline, bounds)
    xmin, ymin, xmax, ymax = bounds
    pad_x, pad_y = 0.018 * (xmax - xmin), 0.025 * (ymax - ymin)

    fig, axes = plt.subplots(1, 4, figsize=(14.15, 4.05), facecolor="white")
    fig.subplots_adjust(left=0.018, right=0.992, top=0.955, bottom=0.15, wspace=0.105)
    for index, (ax, year, field) in enumerate(zip(axes, YEARS, fields)):
        ax.pcolormesh(x_edges, y_edges, np.ma.masked_invalid(field), cmap=CMAP, norm=NORM,
                      shading="flat", edgecolors="none", antialiased=False, rasterized=False)
        draw_cell_grid(ax, x_edges, y_edges, np.isfinite(field))
        draw_boundaries(ax, outline, counties)
        ax.set_xlim(xmin - pad_x, xmax + pad_x)
        ax.set_ylim(ymin - pad_y, ymax + pad_y)
        ax.set_aspect(0.88)
        ax.set_axis_off()
        ax.text(0.00, 1.01, f"({chr(97 + index)}) {year}", transform=ax.transAxes,
                ha="left", va="bottom", fontsize=9.5)
        if index in (0, 2):
            add_legend(ax)
            draw_scale_bar(ax)
        else:
            draw_north_arrow(ax)

    output_stem.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(output_stem.with_suffix(".png"), dpi=300, facecolor="white")
    fig.savefig(output_stem.with_suffix(".pdf"), facecolor="white")
    fig.savefig(output_stem.with_suffix(".svg"), facecolor="white")
    fig.savefig(output_stem.with_suffix(".tiff"), dpi=600, facecolor="white",
                pil_kwargs={"compression": "tiff_lzw"})
    plt.close(fig)


def main() -> None:
    make_figure(ROOT / "outputs" / "esv_grid_zone_scenarios_replica")


if __name__ == "__main__":
    main()
