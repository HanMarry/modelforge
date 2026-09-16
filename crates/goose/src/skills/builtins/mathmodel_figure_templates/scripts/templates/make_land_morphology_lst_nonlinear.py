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

SUMMER_PATTERNS = np.array(
    [
        [0.0, 0.6, 0.25, 0.20, 0.18, -2.4], [0.0, 1.0, 0.25, 0.50, 0.50, 1.25],
        [0.0, 0.3, -0.4, -1.4, -2.0, -3.5], [0.0, -0.3, -0.7, -1.5, -1.8, -3.2],
        [0.0, 1.0, 0.55, -0.7, -1.4, -2.8], [0.0, -0.3, -0.1, -0.9, -1.3, -2.1],
        [0.0, -1.3, -1.0, 1.0, 2.2, 3.5], [0.0, 1.2, 0.1, -0.8, -1.7, -3.7],
        [0.0, 0.4, -0.7, -0.8, -1.8, -2.8], [0.0, -0.1, -0.8, -2.2, -2.7, -3.0],
        [0.0, -0.4, -0.2, -0.9, -0.6, -2.2], [0.0, -0.3, -0.3, 0.6, 1.4, 1.5],
        [0.0, 1.5, 2.1, 2.1, 3.5, 3.7], [0.0, 2.1, 2.7, 2.6, 2.7, 1.0],
        [0.0, 1.9, 2.4, 2.6, 3.1, 2.5], [0.0, 1.8, 3.0, 3.7, 3.2, 1.8],
        [0.0, 2.2, 2.3, 2.3, 2.1, 2.2], [0.0, 1.2, 2.8, 3.2, 3.3, 2.4],
        [0.0, 2.0, 2.4, 2.4, 2.5, 1.7], [0.0, 1.5, 1.8, 2.5, 2.4, 3.2],
    ]
)

WINTER_PATTERNS = np.array(
    [
        [0.0, -0.8, -0.9, -1.1, -0.2, 4.8], [0.0, -0.7, -0.2, -0.3, -0.4, -0.3],
        [0.0, -0.5, -0.8, -1.5, -1.1, -2.5], [0.0, -0.9, -1.2, -1.5, -1.5, -1.3],
        [0.0, -0.8, -0.9, -1.4, -2.0, -1.9], [0.0, -0.8, -1.0, -1.1, -1.3, -1.7],
        [0.0, -0.7, -1.1, -1.4, -1.2, -1.6], [0.0, -1.0, -4.0, -5.0, -4.0, -2.0],
        [0.0, -0.4, -0.8, -0.9, -1.6, -1.7], [0.0, -0.4, -0.7, -1.5, -1.6, -2.3],
        [0.0, -0.3, -1.5, -2.7, -0.2, 5.8], [0.0, 0.6, 1.0, 1.5, 2.0, 2.7],
        [0.0, 0.4, 0.6, 1.2, 1.6, 2.3], [0.0, 1.5, 1.4, 1.6, 0.4, 0.0],
        [0.0, 0.4, 0.9, 1.4, 2.0, 2.1], [0.0, 1.0, 1.7, 2.0, 1.8, 1.4],
        [0.0, 0.9, 1.7, 2.3, 1.8, 1.4], [0.0, 1.3, 1.8, 2.1, 3.1, 2.4],
        [0.0, 0.6, 1.8, 1.6, 1.7, 1.8], [0.0, 0.5, 1.0, 1.6, 0.8, 1.8],
    ]
)


def configure_matplotlib() -> None:
    mpl.rcParams.update(
        {
            "font.family": "sans-serif",
            "font.sans-serif": ["Arial", "Helvetica", "DejaVu Sans", "sans-serif"],
            "font.size": 5.8,
            "axes.linewidth": 0.6,
            "svg.fonttype": "none",
            "pdf.fonttype": 42,
        }
    )


def draw_curve(ax: plt.Axes, pattern: np.ndarray, base: float, metric: str, rng: np.random.Generator) -> None:
    control_x = np.linspace(0, 1, len(pattern))
    x = np.linspace(0, 1, 180)
    y = base + np.interp(x, control_x, pattern)
    uncertainty = 0.18 + 0.12 * np.sin(np.pi * x) ** 2 + 0.08 * rng.random(len(x))
    ax.fill_between(x, y - uncertainty, y + uncertainty, color="#c5c5c5", alpha=0.72, linewidth=0)
    ax.plot(x, y, color="#a5261d", linewidth=1.15)
    padding = max(0.7, 0.11 * (y.max() - y.min() + 1e-6))
    ax.set_ylim(y.min() - padding, y.max() + padding)
    ax.set_xlabel(metric, labelpad=0.5)
    ax.set_ylabel("LST (°C)", labelpad=0.5)
    ax.set_xticks(np.linspace(0, 1, 6))
    ax.grid(True, color="#bdbdbd", linewidth=0.55, alpha=0.75)
    ax.tick_params(labelsize=4.7, length=2.2, pad=1)
    for spine in ax.spines.values():
        spine.set_color("#555555")
        spine.set_linewidth(0.65)


def make_figure(output_stem: Path) -> None:
    configure_matplotlib()
    rng = np.random.default_rng(15040584)
    fig, axes = plt.subplots(8, 5, figsize=(13.0, 18.6), facecolor="white")
    for i, metric in enumerate(METRICS):
        summer_base = 31.3 + 0.35 * np.sin(i * 0.7)
        winter_base = -14.2 + 0.35 * np.cos(i * 0.6)
        draw_curve(axes[i // 5, i % 5], SUMMER_PATTERNS[i], summer_base, metric, rng)
        draw_curve(axes[4 + i // 5, i % 5], WINTER_PATTERNS[i], winter_base, metric, rng)
    fig.subplots_adjust(left=0.058, right=0.985, top=0.97, bottom=0.045, wspace=0.24, hspace=0.31)
    fig.text(0.06, 0.988, "(a) Summer", fontsize=12, ha="left", va="top")
    fig.text(0.06, 0.498, "(b) Winter", fontsize=12, ha="left", va="top")
    output_stem.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(output_stem.with_suffix(".png"), dpi=300, facecolor="white")
    fig.savefig(output_stem.with_suffix(".pdf"), facecolor="white")
    fig.savefig(output_stem.with_suffix(".svg"), facecolor="white")
    plt.close(fig)


def main() -> None:
    make_figure(ROOT / "outputs" / "land_morphology_lst_nonlinear_replica")


if __name__ == "__main__":
    main()
