from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("MPLCONFIGDIR", str(ROOT / ".mplconfig"))

import matplotlib as mpl

mpl.use("Agg")
import matplotlib.pyplot as plt
import numpy as np


MODELS = ["XGBoost", "SVM", "RF", "MLR"]
ERROR_LEVELS = {"XGBoost": 0.22, "SVM": 0.38, "RF": 0.30, "MLR": 0.50}


def configure_matplotlib() -> None:
    mpl.rcParams.update(
        {
            "font.family": "sans-serif",
            "font.sans-serif": ["Arial", "Helvetica", "DejaVu Sans", "sans-serif"],
            "font.size": 8,
            "axes.linewidth": 0.75,
            "svg.fonttype": "none",
            "pdf.fonttype": 42,
        }
    )


def simulate_truth(rng: np.random.Generator, season: str, n: int = 150) -> np.ndarray:
    if season == "summer":
        values = 27.7 + rng.normal(0, 1.1, n) + 0.22 * np.sin(np.linspace(0, 10 * np.pi, n))
        return np.clip(values, 24.2, 30.0)
    values = -11.1 + rng.normal(0, 1.15, n) + 0.20 * np.cos(np.linspace(0, 9 * np.pi, n))
    return np.clip(values, -14.6, -8.6)


def draw_panel(ax: plt.Axes, model: str, truth: np.ndarray, season: str, rng: np.random.Generator) -> None:
    split = 105
    n = len(truth)
    x = np.arange(n)
    error = ERROR_LEVELS[model]
    pred = truth + rng.normal(0, error, n)
    if model == "MLR":
        pred = 0.72 * truth + 0.28 * truth.mean() + rng.normal(0, error * 0.55, n)
    train_true = "#68ad99" if season == "summer" else "#5b91e8"
    train_pred = "#a9d2c6" if season == "summer" else "#a9c9f8"
    test_true = "#ff7f9a" if season == "summer" else "#ff785d"
    test_pred = "#ffc0cb" if season == "summer" else "#f6bea9"
    ax.plot(x[:split], truth[:split], color=train_true, linewidth=0.7, marker="o", markersize=2.2, label="Train True")
    ax.plot(x[:split], pred[:split], color=train_pred, linewidth=0.55, marker="x", markersize=2.0, label="Train Pred")
    ax.plot(x[split:], truth[split:], color=test_true, linewidth=0.7, marker="o", markersize=2.2, label="Test True")
    ax.plot(x[split:], pred[split:], color=test_pred, linewidth=0.55, marker="x", markersize=2.0, label="Test Pred")
    ax.axvline(split - 0.5, color="#777777", linestyle="--", linewidth=0.7)
    ax.text(0.015, 0.96, model, transform=ax.transAxes, ha="left", va="top", fontsize=12)
    ax.set_xlim(-7, n + 6)
    ax.set_xlabel("Sample Index", labelpad=1)
    ax.set_ylabel("LST (°C)", labelpad=2)
    ax.grid(False)
    ax.legend(loc="lower right", frameon=True, framealpha=0.70, fontsize=5.8, borderpad=0.3, handlelength=2)
    ax.tick_params(labelsize=7, length=2.5, pad=1)
    for spine in ax.spines.values():
        spine.set_color("#666666")


def make_figure(output_stem: Path) -> None:
    configure_matplotlib()
    rng = np.random.default_rng(15040588)
    summer_truth = simulate_truth(rng, "summer")
    winter_truth = simulate_truth(rng, "winter")
    fig, axes = plt.subplots(4, 2, figsize=(13.5, 15.8), facecolor="white")
    for idx, model in enumerate(MODELS):
        draw_panel(axes[idx // 2, idx % 2], model, summer_truth, "summer", rng)
        draw_panel(axes[2 + idx // 2, idx % 2], model, winter_truth, "winter", rng)
    fig.subplots_adjust(left=0.065, right=0.985, top=0.955, bottom=0.055, wspace=0.08, hspace=0.22)
    fig.text(0.02, 0.985, "(a) Summer", fontsize=15, ha="left", va="top")
    fig.text(0.02, 0.505, "(b) Winter", fontsize=15, ha="left", va="top")
    fig.add_artist(plt.Line2D([0.012, 0.995], [0.515, 0.515], transform=fig.transFigure, color="#333333", linewidth=0.8))
    output_stem.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(output_stem.with_suffix(".png"), dpi=300, facecolor="white")
    fig.savefig(output_stem.with_suffix(".pdf"), facecolor="white")
    fig.savefig(output_stem.with_suffix(".svg"), facecolor="white")
    plt.close(fig)


def main() -> None:
    make_figure(ROOT / "outputs" / "land_model_prediction_comparison_replica")


if __name__ == "__main__":
    main()
