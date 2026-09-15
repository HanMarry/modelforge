from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("MPLCONFIGDIR", str(ROOT / ".mplconfig"))

import matplotlib as mpl

mpl.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.colors import LinearSegmentedColormap
import numpy as np


PANELS = [
    ("PLAND", "LPI", 100.0, 100.0), ("PD", "LPI", 210.0, 100.0),
    ("PD", "PLAND", 210.0, 75.0), ("ED", "LPI", 280.0, 100.0),
    ("BH", "LPI", 80.0, 100.0), ("ED", "LPI", 280.0, 140.0),
    ("PD", "LPI", 210.0, 100.0), ("ED", "LPI", 280.0, 100.0),
    ("BO", "LPI", 2.2, 100.0), ("BO", "PD", 2.2, 140.0),
]


def configure_matplotlib() -> None:
    mpl.rcParams.update(
        {
            "font.family": "sans-serif",
            "font.sans-serif": ["Arial", "Helvetica", "DejaVu Sans", "sans-serif"],
            "font.size": 7.4,
            "axes.linewidth": 0.7,
            "svg.fonttype": "none",
            "pdf.fonttype": 42,
        }
    )


def simulate_x(rng: np.random.Generator, xmax: float, panel: int, n: int = 430) -> np.ndarray:
    if panel in (4, 8, 9):
        x = rng.gamma(shape=0.85, scale=xmax / 5.0, size=n)
    elif panel in (1, 2, 6):
        x = np.r_[rng.gamma(1.2, xmax / 8.5, n * 3 // 4), rng.uniform(0.2 * xmax, xmax, n - n * 3 // 4)]
    else:
        x = np.r_[rng.beta(1.3, 3.0, n * 4 // 5) * xmax, rng.uniform(0.45 * xmax, xmax, n - n * 4 // 5)]
    return np.clip(x, 0, xmax)


def interaction_values(panel: int, x: np.ndarray, color_value: np.ndarray, xmax: float, cmax: float,
                       rng: np.random.Generator) -> np.ndarray:
    xn = x / xmax
    cn = color_value / cmax
    noise = rng.normal(0, 0.07 + 0.12 * xn, len(x))
    if panel == 0:
        y = np.where(cn < 0.35, -0.85 + 0.65 * xn, 0.50 + 1.45 * np.exp(-((xn - 0.42) / 0.14) ** 2))
        y -= np.where(xn > 0.62, 8.5 * (xn - 0.62), 0)
    elif panel == 1:
        y = 0.05 + 0.65 * (cn - 0.5) + 0.35 * np.sin(8 * xn) - 0.35 * xn
        y += rng.normal(0, 0.20 + 0.34 * xn, len(x))
    elif panel == 2:
        y = -0.12 + 0.60 * np.exp(-((xn - 0.20) / 0.20) ** 2) - 0.55 * xn * cn
        y += np.where((xn > 0.35) & (cn > 0.75), -1.5 * rng.random(len(x)), 0)
    elif panel == 3:
        y = -0.30 + 0.38 * xn + 0.20 * (cn - 0.5) + rng.normal(0, 0.12, len(x))
        y += np.where((xn > 0.25) & (cn > 0.78), rng.exponential(0.42, len(x)), 0)
    elif panel == 4:
        y = 0.02 + 0.08 * np.sin(7 * xn) + 0.18 * (0.5 - cn) + noise
        y += np.where(xn < 0.04, rng.normal(-0.15, 0.45, len(x)), 0)
        y += np.where((xn > 0.45) & (cn > 0.8), -0.55 * rng.random(len(x)), 0)
    elif panel == 5:
        branch = np.where(cn < 0.35, -0.75 * xn, np.where(cn > 0.72, 0.75 * np.exp(-((xn - 0.55) / 0.28) ** 2), 0.05))
        y = branch + rng.normal(0, 0.12 + 0.12 * xn, len(x))
        y += np.where((xn < 0.25) & (cn < 0.35), 1.2 * rng.random(len(x)), 0)
    elif panel == 6:
        y = np.where(cn < 0.35, -0.15 - 0.65 * xn, np.where(cn > 0.70, 0.22 - 0.25 * xn, -0.10))
        y += rng.normal(0, 0.11 + 0.15 * xn, len(x))
        y += np.where((xn < 0.28) & (cn < 0.30), 1.3 * rng.random(len(x)), 0)
    elif panel == 7:
        y = np.where(cn < 0.35, 0.08 - 0.30 * xn, np.where(cn > 0.70, -0.25 - 0.55 * xn, 0.32 - 0.25 * xn))
        y += rng.normal(0, 0.10 + 0.13 * xn, len(x))
    elif panel == 8:
        y = 0.09 * np.exp(-2.0 * xn) + 0.24 * (cn - 0.55) + rng.normal(0, 0.08 + 0.06 * xn, len(x))
        y += np.where((xn < 0.07) & (cn < 0.30), 0.75 * rng.normal(0, 0.7, len(x)), 0)
    else:
        y = 0.12 * np.exp(-3.0 * xn) - 0.18 * (cn > 0.62) + rng.normal(0, 0.07 + 0.04 * xn, len(x))
        y += np.where(xn < 0.06, rng.normal(-0.05, 0.24, len(x)), 0)
    return y + noise


def make_figure(output_stem: Path) -> None:
    configure_matplotlib()
    rng = np.random.default_rng(15040586)
    cmap = LinearSegmentedColormap.from_list("interaction", ["#0078f0", "#4a43d2", "#c000a6", "#ff0055"])
    fig, axes = plt.subplots(3, 4, figsize=(15.2, 10.2), facecolor="white")
    positions = [(0, 0), (0, 1), (0, 2), (0, 3), (1, 0), (1, 1), (1, 2), (1, 3), (2, 0), (2, 1)]
    for panel, (row, col) in enumerate(positions):
        ax = axes[row, col]
        xlabel, color_label, xmax, cmax = PANELS[panel]
        x = simulate_x(rng, xmax, panel)
        color_value = rng.uniform(0, cmax, len(x))
        y = interaction_values(panel, x, color_value, xmax, cmax, rng)
        scatter = ax.scatter(x, y, c=color_value, cmap=cmap, vmin=0, vmax=cmax, s=6.5, alpha=0.92,
                             edgecolors="none", rasterized=True)
        ax.text(0.01, 0.99, f"({chr(97 + panel)})", transform=ax.transAxes, ha="left", va="top", fontsize=11)
        ax.set_xlabel(xlabel, labelpad=1)
        if col == 0:
            ax.set_ylabel("SHAP interaction value", labelpad=2)
        ax.tick_params(labelsize=6.5, length=2.5, pad=1)
        ax.spines["top"].set_visible(False)
        ax.spines["right"].set_visible(False)
        cax = ax.inset_axes([1.045, 0.0, 0.026, 1.0])
        colorbar = fig.colorbar(scatter, cax=cax)
        colorbar.ax.tick_params(labelsize=6, length=2, pad=1)
        colorbar.outline.set_visible(False)
        colorbar.set_label(color_label, fontsize=6.5, labelpad=2)
    axes[2, 2].axis("off")
    axes[2, 3].axis("off")
    fig.subplots_adjust(left=0.055, right=0.985, top=0.975, bottom=0.065, wspace=0.36, hspace=0.28)
    output_stem.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(output_stem.with_suffix(".png"), dpi=300, facecolor="white")
    fig.savefig(output_stem.with_suffix(".pdf"), facecolor="white")
    fig.savefig(output_stem.with_suffix(".svg"), facecolor="white")
    plt.close(fig)


def main() -> None:
    make_figure(ROOT / "outputs" / "land_shap_interactions_replica")


if __name__ == "__main__":
    main()
