from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("MPLCONFIGDIR", str(ROOT / ".mplconfig"))

import matplotlib as mpl

mpl.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.colors import BoundaryNorm, ListedColormap
from matplotlib.patches import Polygon
import numpy as np


SUMMER_TIMES = ["00:44", "04:27", "08:25", "10:20", "12:54", "14:38", "16:40", "18:19", "19:07", "average"]
WINTER_TIMES = ["00:19", "01:44", "07:22", "08:37", "09:48", "10:30", "12:12", "15:10", "23:38", "average"]


def configure_matplotlib() -> None:
    mpl.rcParams.update(
        {
            "font.family": "sans-serif",
            "font.sans-serif": ["Arial", "Helvetica", "DejaVu Sans", "sans-serif"],
            "font.size": 8,
            "axes.linewidth": 0.65,
            "svg.fonttype": "none",
            "pdf.fonttype": 42,
        }
    )


def smooth2d(values: np.ndarray, passes: int = 5) -> np.ndarray:
    out = values.copy()
    for _ in range(passes):
        out = (
            out
            + np.roll(out, 1, 0)
            + np.roll(out, -1, 0)
            + np.roll(out, 1, 1)
            + np.roll(out, -1, 1)
        ) / 5.0
    return out


def study_mask(xx: np.ndarray, yy: np.ndarray) -> np.ndarray:
    radius = ((xx - 0.50) / (0.48 + 0.035 * np.sin(4 * yy))) ** 2 + ((yy - 0.50) / 0.43) ** 2
    clipped = radius < (1.0 + 0.05 * np.sin(8 * xx) - 0.04 * np.cos(7 * yy))
    river = np.abs(yy - (0.66 - 0.15 * xx + 0.035 * np.sin(10 * xx))) < 0.012
    return clipped, river


def simulate_lst_fields(seed: int = 15040585) -> tuple[list[np.ndarray], list[np.ndarray], np.ndarray]:
    rng = np.random.default_rng(seed)
    ny, nx = 175, 190
    y = np.linspace(0, 1, ny)
    x = np.linspace(0, 1, nx)
    xx, yy = np.meshgrid(x, y)
    mask, river = study_mask(xx, yy)
    noise = smooth2d(rng.normal(size=(ny, nx)), 6)
    roads = 0.35 * np.sin(32 * (xx + 0.42 * yy)) + 0.24 * np.cos(40 * (yy - 0.25 * xx))
    center = np.exp(-(((xx - 0.58) / 0.27) ** 2 + ((yy - 0.50) / 0.24) ** 2))
    base = 1.25 * center + 0.55 * roads + 2.4 * noise
    summer_means = np.array([15.5, 14.2, 27.5, 38.0, 46.0, 31.0, 28.4, 24.5, 23.2])
    winter_means = np.array([-15.2, -17.0, -13.0, -8.5, -6.0, -5.3, -7.5, -10.5, -14.2])
    summer: list[np.ndarray] = []
    winter: list[np.ndarray] = []
    for i, mean in enumerate(summer_means):
        field = mean + (2.4 + 0.3 * np.sin(i)) * base + 0.7 * np.sin((i + 1) * xx * np.pi)
        field = field.copy()
        field[river] -= 2.5
        summer.append(np.ma.masked_where(~mask, field))
    for i, mean in enumerate(winter_means):
        field = mean + (2.0 + 0.2 * np.cos(i)) * base + 0.5 * np.cos((i + 2) * yy * np.pi)
        field = field.copy()
        field[river] -= 1.4
        winter.append(np.ma.masked_where(~mask, field))
    summer.append(np.ma.mean(np.ma.stack(summer), axis=0))
    winter.append(np.ma.mean(np.ma.stack(winter), axis=0))
    return summer, winter, mask


def draw_north_arrow(ax: plt.Axes) -> None:
    tri = Polygon([[0.92, 0.80], [0.96, 0.96], [0.99, 0.80], [0.955, 0.84]], closed=True, transform=ax.transAxes,
                  facecolor="white", edgecolor="#222222", linewidth=0.7)
    ax.add_patch(tri)
    ax.text(0.955, 0.76, "N", transform=ax.transAxes, ha="center", va="top", fontsize=6)


def draw_map(ax: plt.Axes, field: np.ndarray, cmap: mpl.colors.Colormap, norm: BoundaryNorm, label: str, time: str) -> None:
    ax.imshow(field, origin="lower", cmap=cmap, norm=norm, interpolation="bilinear")
    ax.text(0.015, 0.975, f"({label})", transform=ax.transAxes, ha="left", va="top", fontsize=8)
    ax.text(0.50, 0.965, time, transform=ax.transAxes, ha="center", va="top", fontsize=8)
    draw_north_arrow(ax)
    ax.set_xticks([])
    ax.set_yticks([])
    for spine in ax.spines.values():
        spine.set_color("#707070")
        spine.set_linewidth(0.6)


def kde(values: np.ndarray, grid: np.ndarray, bandwidth: float) -> np.ndarray:
    diff = (grid[:, None] - values[None, :]) / bandwidth
    density = np.exp(-0.5 * diff**2).sum(axis=1)
    return density / max(density.max(), 1e-9)


def draw_ridges(ax: plt.Axes, fields: list[np.ndarray], times: list[str], xlim: tuple[float, float]) -> None:
    grid = np.linspace(*xlim, 260)
    rng = np.random.default_rng(221)
    for row, (field, time) in enumerate(zip(fields[:9], times[:9])):
        values = field.compressed()
        if len(values) > 1600:
            values = rng.choice(values, 1600, replace=False)
        density = kde(values, grid, bandwidth=(xlim[1] - xlim[0]) / 45)
        baseline = 8 - row
        ax.fill_between(grid, baseline, baseline + 0.85 * density, facecolor="#777777", alpha=0.72,
                        edgecolor="#222222", linewidth=0.65)
        median = float(np.median(values))
        ax.plot([median, median], [baseline, baseline + 0.58], color="#d45a4b", linewidth=0.75)
        ax.hlines(baseline, xlim[0], xlim[1], color="#444444", linewidth=0.45)
        ax.text(xlim[0] + 0.018 * (xlim[1] - xlim[0]), baseline + 0.12, time, ha="left", va="center", fontsize=6.5)
    ax.set_xlim(*xlim)
    ax.set_ylim(-0.35, 9.15)
    ax.set_yticks([])
    ax.set_xlabel("LST (°C)", labelpad=1)
    ax.text(-0.10, 0.50, "Time (24h)", transform=ax.transAxes, rotation=90, ha="center", va="center")
    for side in ("top", "right", "left"):
        ax.spines[side].set_visible(False)


def add_discrete_key(fig: plt.Figure, rect: list[float], bounds: list[float], colors: list[str], title: str) -> None:
    ax = fig.add_axes(rect)
    ax.set_xlim(0, 1)
    ax.set_ylim(0, len(colors))
    for i, color in enumerate(colors):
        y = len(colors) - i - 1
        ax.add_patch(plt.Rectangle((0.05, y + 0.12), 0.18, 0.76, facecolor=color, edgecolor="none"))
        if i == 0:
            label = f">{bounds[-2]:g}"
        elif i == len(colors) - 1:
            label = f"≤{bounds[0]:g}"
        else:
            high = bounds[-i - 1]
            low = bounds[-i - 2]
            label = f"({low:g},{high:g}]"
        ax.text(0.31, y + 0.50, label, va="center", fontsize=6.2)
    ax.text(0.02, len(colors) + 0.12, title, fontsize=7.5, weight="bold", va="bottom")
    ax.axis("off")


def make_figure(output_stem: Path) -> None:
    configure_matplotlib()
    summer, winter, _ = simulate_lst_fields()
    colors = ["#2b83ba", "#3d96c1", "#58a9bf", "#76baad", "#98ca93", "#bbda78", "#dce75f", "#f5e74b", "#fecb3e", "#fda331", "#f77a27", "#ea4c20", "#d7191c"]
    summer_bounds = list(np.arange(11, 51, 3))
    winter_bounds = list(np.arange(-26, 2, 2))
    summer_cmap = ListedColormap(colors)
    winter_cmap = ListedColormap(colors)
    summer_norm = BoundaryNorm(summer_bounds, summer_cmap.N, clip=True)
    winter_norm = BoundaryNorm(winter_bounds, winter_cmap.N, clip=True)

    fig = plt.figure(figsize=(12.2, 17.2), facecolor="white")
    outer = fig.add_gridspec(2, 1, left=0.045, right=0.91, top=0.965, bottom=0.055, hspace=0.12)
    letters = list("abcdefghij")
    for season_idx, (fields, times, cmap, norm, xlim, title) in enumerate(
        [
            (summer, SUMMER_TIMES, summer_cmap, summer_norm, (5, 60), "Summer"),
            (winter, WINTER_TIMES, winter_cmap, winter_norm, (-30, 0), "Winter"),
        ]
    ):
        grid = outer[season_idx].subgridspec(3, 4, wspace=0.045, hspace=0.045)
        positions = [(0, 0), (0, 1), (0, 2), (0, 3), (1, 0), (1, 1), (1, 2), (1, 3), (2, 0), (2, 1)]
        for idx, (row, col) in enumerate(positions):
            ax = fig.add_subplot(grid[row, col])
            draw_map(ax, fields[idx], cmap, norm, f"{letters[idx]}{season_idx + 1}", times[idx])
        ridge_ax = fig.add_subplot(grid[2, 2:4])
        ridge_ax.text(0.01, 0.98, f"(k{season_idx + 1})", transform=ridge_ax.transAxes, ha="left", va="top")
        draw_ridges(ridge_ax, fields, times, xlim)
        y_title = 0.975 if season_idx == 0 else 0.495
        fig.text(0.045, y_title, title, fontsize=12, ha="left", va="bottom")

    add_discrete_key(fig, [0.915, 0.535, 0.080, 0.42], summer_bounds, colors[::-1], "LST (°C)")
    add_discrete_key(fig, [0.915, 0.065, 0.080, 0.39], winter_bounds, colors[::-1], "LST (°C)")
    fig.text(0.87, 0.032, "0      5      10                 20 km", fontsize=6.5)
    fig.add_artist(plt.Line2D([0.87, 0.965], [0.043, 0.043], transform=fig.transFigure, color="#222222", linewidth=0.8))
    for x in np.linspace(0.87, 0.965, 5):
        fig.add_artist(plt.Line2D([x, x], [0.039, 0.047], transform=fig.transFigure, color="#222222", linewidth=0.7))

    output_stem.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(output_stem.with_suffix(".png"), dpi=300, facecolor="white")
    fig.savefig(output_stem.with_suffix(".pdf"), facecolor="white")
    fig.savefig(output_stem.with_suffix(".svg"), facecolor="white")
    plt.close(fig)


def main() -> None:
    make_figure(ROOT / "outputs" / "land_diurnal_lst_maps_replica")


if __name__ == "__main__":
    main()
