from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("MPLCONFIGDIR", str(ROOT / ".mplconfig"))

import matplotlib as mpl

mpl.use("Agg")
import matplotlib.pyplot as plt
import numpy as np


METRICS = ["PD", "NP", "ED", "AI", "SHAPE", "LSI", "LPI", "PLAND", "NDVI", "LAI", "TH", "RD", "BD", "BH", "FAR", "VOL", "BSI", "BO", "UBSD", "SCD"]
SUMMER_SLOPES = [-8.8, -1.5, -6.3, -6.5, -11.0, -5.9, 7.9, -7.9, -7.2, -5.9, -2.0, 3.2, 6.7, 0.2, 3.9, 2.1, 2.1, 1.7, 1.6, 5.8]
WINTER_SLOPES = [5.8, -0.7, -2.3, -2.2, -4.2, -2.0, -4.4, -2.1, -4.5, -4.4, 1.0, 2.4, 5.6, 0.3, 3.2, 0.4, 0.3, 4.0, 0.8, 5.2]
WINTER_MAX = [210, 11, 230, 100, 3.0, 4.2, 100, 100, 1.0, 1.0, 520, 1.0, 0.45, 82, 13, 120000, 700, 2.2, 1100, 0.48]


def configure_matplotlib() -> None:
    mpl.rcParams.update(
        {
            "font.family": "sans-serif",
            "font.sans-serif": ["Arial", "Helvetica", "DejaVu Sans", "sans-serif"],
            "font.size": 5.6,
            "axes.linewidth": 0.55,
            "xtick.major.width": 0.45,
            "ytick.major.width": 0.45,
            "svg.fonttype": "none",
            "pdf.fonttype": 42,
        }
    )


def simulate_metric(rng: np.random.Generator, metric_index: int, n: int = 260) -> np.ndarray:
    shape = metric_index % 5
    if shape == 0:
        x = rng.beta(0.85, 3.2, n)
    elif shape == 1:
        x = rng.beta(1.3, 1.6, n)
    elif shape == 2:
        x = rng.beta(0.65, 2.2, n)
    elif shape == 3:
        x = np.clip(np.r_[rng.beta(0.7, 4.0, n * 3 // 4), rng.uniform(0.3, 1.0, n - n * 3 // 4)], 0, 1)
    else:
        x = np.clip(rng.normal(0.43, 0.20, n), 0, 1)
    return x


def draw_panel(ax: plt.Axes, metric_index: int, season: str, rng: np.random.Generator) -> None:
    normalized_x = simulate_metric(rng, metric_index)
    if season == "summer":
        xmax = 1.0
        slope = SUMMER_SLOPES[metric_index]
        base = 34.0 + 0.55 * np.sin(metric_index)
        noise = rng.normal(0, 2.4 + 0.3 * (metric_index % 3), len(normalized_x))
        y = base + slope * (normalized_x - 0.25) + noise
        ylim = (23, 43)
    else:
        xmax = WINTER_MAX[metric_index]
        slope = WINTER_SLOPES[metric_index]
        base = -15.0 + 0.4 * np.cos(metric_index)
        noise = rng.normal(0, 2.25 + 0.15 * (metric_index % 4), len(normalized_x))
        y = base + slope * (normalized_x - 0.25) + noise
        if metric_index == 0:
            second = rng.uniform(0.02, 0.32, 55)
            normalized_x[:55] = second
            y[:55] = -9.5 + rng.normal(0, 0.8, 55)
        ylim = (-23, -4)
    x = normalized_x * xmax
    ax.scatter(x, y, s=7, color="#58a6d4", alpha=0.52, edgecolors="none", rasterized=True)
    coeff = np.polyfit(x, y, 1)
    xx = np.linspace(0, xmax, 80)
    yy = coeff[0] * xx + coeff[1]
    ax.plot(xx, yy, color="#9c1c14", linewidth=1.0)
    pred = np.polyval(coeff, x)
    r2 = 1 - np.sum((y - pred) ** 2) / np.sum((y - y.mean()) ** 2)
    ax.text(0.04, 0.05, f"y = {coeff[1]:.1f} {coeff[0]:+.3f}x\n$R^2$ = {max(r2, 0):.2f}", transform=ax.transAxes,
            fontsize=4.6, ha="left", va="bottom", color="#444444")
    ax.set_xlim(0, xmax)
    ax.set_ylim(*ylim)
    ax.set_xlabel(METRICS[metric_index], labelpad=0.5)
    ax.set_ylabel("LST (°C)", labelpad=0.5)
    ax.grid(True, color="#d3d3d3", linewidth=0.45, alpha=0.8)
    ax.tick_params(labelsize=4.5, length=2, pad=1)
    for spine in ax.spines.values():
        spine.set_color("#c8c8c8")


def make_figure(output_stem: Path) -> None:
    configure_matplotlib()
    rng = np.random.default_rng(15040583)
    fig, axes = plt.subplots(8, 5, figsize=(12.8, 18.6), facecolor="white")
    for idx in range(20):
        draw_panel(axes[idx // 5, idx % 5], idx, "summer", rng)
        draw_panel(axes[4 + idx // 5, idx % 5], idx, "winter", rng)
    fig.subplots_adjust(left=0.06, right=0.985, top=0.968, bottom=0.045, wspace=0.27, hspace=0.33)
    fig.text(0.057, 0.985, "(a) Summer", fontsize=12, ha="left", va="top")
    fig.text(0.057, 0.495, "(b) Winter", fontsize=12, ha="left", va="top")
    output_stem.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(output_stem.with_suffix(".png"), dpi=300, facecolor="white")
    fig.savefig(output_stem.with_suffix(".pdf"), facecolor="white")
    fig.savefig(output_stem.with_suffix(".svg"), facecolor="white")
    plt.close(fig)


def main() -> None:
    make_figure(ROOT / "outputs" / "land_morphology_lst_linear_replica")


if __name__ == "__main__":
    main()
