from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("MPLCONFIGDIR", str(ROOT / ".mplconfig"))

import matplotlib as mpl

mpl.use("Agg")
import matplotlib.pyplot as plt
import numpy as np


SUMMER_METRICS = ["BO", "LAI", "BH", "NDVI", "NP", "BD", "PLAND", "BSI", "FAR", "VOL", "PD", "ED", "AI", "SHAPE", "TH", "RD", "UBSD", "LPI", "LSI", "SCD"]
WINTER_METRICS = ["BH", "NDVI", "LPI", "BO", "PLAND", "LAI", "VOL", "FAR", "NP", "ED", "UBSD", "AI", "SHAPE", "TH", "RD", "BD", "BSI", "PD", "SCD", "LSI"]
SUMMER_TIMES = ["average", "00:44", "04:27", "08:25", "10:20", "12:54", "14:38", "16:40", "18:19", "19:07"]
WINTER_TIMES = ["average", "00:19", "01:44", "07:22", "08:37", "09:48", "10:30", "12:12", "15:10", "23:38"]


def configure_matplotlib() -> None:
    mpl.rcParams.update(
        {
            "font.family": "sans-serif",
            "font.sans-serif": ["Arial", "Helvetica", "DejaVu Sans", "sans-serif"],
            "font.size": 9,
            "axes.linewidth": 0.8,
            "svg.fonttype": "none",
            "pdf.fonttype": 42,
        }
    )


def simulate_importance(base: np.ndarray, n_times: int, rng: np.random.Generator) -> np.ndarray:
    time_factor = np.linspace(1.2, 0.55, n_times)[:, None]
    values = base[None, :] * time_factor * rng.lognormal(mean=0.0, sigma=0.28, size=(n_times, len(base)))
    return np.clip(values, 0.4, None)


def draw_time_wheel(ax: plt.Axes, times: list[str], colors: np.ndarray, title_y: float = 0.56) -> None:
    theta = np.linspace(np.pi * 0.68, np.pi * 0.68 - 2 * np.pi, len(times), endpoint=False)
    cx, cy, radius = 0.52, 0.72, 0.20
    for angle, label, color in zip(theta, times, colors):
        x = cx + radius * np.cos(angle)
        y = cy + radius * np.sin(angle)
        ax.scatter([x], [y], s=95, color=color, edgecolor="white", linewidth=0.6)
        ax.text(x, y + 0.048, label, ha="center", va="center", fontsize=7.5)
    ax.text(cx, title_y, "Time", fontsize=11, ha="center", va="center", weight="bold")
    ax.text(0.08, 0.39, "Relative importance", fontsize=10.5, ha="left", weight="bold")
    size_values = [8, 16, 24, 32, 40]
    for i, value in enumerate(size_values):
        y = 0.30 - i * 0.058
        ax.scatter([0.28], [y], s=10 + value * 2.0, color="#333333")
        ax.text(0.42, y, str(value), va="center", fontsize=8.5)
    ax.set_xlim(0, 1)
    ax.set_ylim(0, 1)
    ax.set_xticks([])
    ax.set_yticks([])
    for spine in ax.spines.values():
        spine.set_color("#555555")


def draw_bubbles(ax: plt.Axes, metrics: list[str], values: np.ndarray, colors: np.ndarray, ylim: tuple[float, float], panel: str) -> None:
    x = np.arange(len(metrics))
    for t in range(values.shape[0]):
        ax.scatter(x, values[t], s=12 + 4.6 * values[t], color=colors[t], alpha=0.94,
                   edgecolor="white", linewidth=0.4)
    ax.set_xlim(-0.9, len(metrics) - 0.1)
    ax.set_ylim(*ylim)
    ax.set_xticks(x)
    ax.set_xticklabels(metrics, rotation=90)
    ax.set_ylabel("Relative importance (%)", fontsize=11)
    ax.grid(axis="y", color="#c8c8c8", linestyle="--", linewidth=0.65, alpha=0.75)
    ax.text(0.01, 0.98, panel, transform=ax.transAxes, ha="left", va="top", fontsize=16)
    ax.tick_params(labelsize=8)


def make_figure(output_stem: Path) -> None:
    configure_matplotlib()
    rng = np.random.default_rng(15040585)
    summer_base = np.array([17, 15, 16, 14, 13, 12, 11, 8, 9, 8, 8, 7, 9, 8, 7, 6, 7, 6, 6, 7], dtype=float)
    winter_base = np.array([40, 33, 16, 15, 13, 5, 10, 9, 7, 6, 7, 6, 6, 10, 5, 9, 5, 4, 4, 4], dtype=float)
    summer = simulate_importance(summer_base, len(SUMMER_TIMES), rng)
    winter = simulate_importance(winter_base, len(WINTER_TIMES), rng)
    summer[5, SUMMER_METRICS.index("NDVI")] = 45.89
    winter[2, WINTER_METRICS.index("BH")] = 89.24
    winter[1, WINTER_METRICS.index("BH")] = 82.0
    winter[0, WINTER_METRICS.index("BH")] = 75.1

    summer_colors = mpl.colormaps["viridis"](np.linspace(0.08, 0.90, len(SUMMER_TIMES)))
    winter_colors = mpl.colormaps["coolwarm"](np.linspace(0.12, 0.88, len(WINTER_TIMES)))
    fig = plt.figure(figsize=(13.0, 11.0), facecolor="white")
    grid = fig.add_gridspec(2, 2, width_ratios=[4.2, 1.35], left=0.07, right=0.98, top=0.97, bottom=0.08,
                            hspace=0.18, wspace=0.0)
    summer_ax = fig.add_subplot(grid[0, 0])
    summer_key = fig.add_subplot(grid[0, 1])
    winter_ax = fig.add_subplot(grid[1, 0])
    winter_key = fig.add_subplot(grid[1, 1])
    draw_bubbles(summer_ax, SUMMER_METRICS, summer, summer_colors, (-2, 48), "(a) Summer")
    draw_time_wheel(summer_key, SUMMER_TIMES, summer_colors)
    draw_bubbles(winter_ax, WINTER_METRICS, winter, winter_colors, (-3, 93), "(b) Winter")
    draw_time_wheel(winter_key, WINTER_TIMES, winter_colors)
    winter_ax.set_xlabel("Urban morphology metrics", fontsize=12, labelpad=8)
    output_stem.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(output_stem.with_suffix(".png"), dpi=300, facecolor="white")
    fig.savefig(output_stem.with_suffix(".pdf"), facecolor="white")
    fig.savefig(output_stem.with_suffix(".svg"), facecolor="white")
    plt.close(fig)


def main() -> None:
    make_figure(ROOT / "outputs" / "land_diurnal_feature_importance_replica")


if __name__ == "__main__":
    main()
