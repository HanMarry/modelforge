from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("MPLCONFIGDIR", str(ROOT / ".mplconfig"))

import matplotlib as mpl

mpl.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.colors import LinearSegmentedColormap, TwoSlopeNorm


OUTPUT = (
    ROOT / "outputs" / "10-1038-s44304-025-00146-8" / "figure-9" / "landslide_shap_decision_heatmaps_replica"
    if (ROOT / "sources" / "10-1038-s44304-025-00146-8").exists()
    else ROOT / "outputs" / "landslide_shap_decision_heatmaps_replica"
)

FEATURES_IGNEOUS = [
    "Precip td",
    "Precip -1d",
    "Precip -2d",
    "Water Content",
    "Cohesion",
    "Precip -4d",
    "Slope Height",
    "Precip -3d",
    "Sum of 7 other features",
]
FEATURES_SEDIMENTARY = [
    "Precip td",
    "Precip -1d",
    "Slope Length",
    "Precip -2d",
    "Precip -3d",
    "Aspect",
    "Precip -4d",
    "Slope",
    "Sum of 7 other features",
]


def configure_matplotlib() -> None:
    mpl.rcParams.update(
        {
            "font.family": "sans-serif",
            "font.sans-serif": ["Arial", "Helvetica", "DejaVu Sans", "sans-serif"],
            "font.size": 8,
            "axes.linewidth": 0.65,
            "axes.spines.right": False,
            "axes.spines.top": False,
            "svg.fonttype": "none",
            "pdf.fonttype": 42,
        }
    )


def _smooth(values: np.ndarray, width: int = 9) -> np.ndarray:
    kernel = np.ones(width) / width
    return np.convolve(values, kernel, mode="same")


def simulate_decision_heatmap(
    n: int, vmax: float, kind: str, seed: int
) -> tuple[np.ndarray, np.ndarray]:
    rng = np.random.default_rng(seed)
    x = np.linspace(0, 1, n)
    if kind == "igneous":
        regime = np.tanh((0.61 - x) * 11) + 0.52 * np.tanh((x - 0.90) * 22)
        first = 0.25 * regime + rng.normal(0, 0.027, n)
        second = 0.07 * np.sin(7.5 * x + 0.4) + rng.normal(0, 0.028, n)
        output = 0.58 + 0.31 * np.tanh(6 * first) + 0.08 * np.sin(12 * x)
    else:
        regime = np.tanh((0.54 - x) * 10) + 0.45 * np.tanh((x - 0.91) * 27)
        first = 0.28 * regime + rng.normal(0, 0.035, n)
        second = 0.11 * np.sin(8.8 * x - 1.2) + rng.normal(0, 0.032, n)
        output = 0.59 + 0.29 * np.tanh(5.5 * first) + 0.11 * np.sin(15 * x)

    rows = [first, second]
    for i in range(2, 8):
        base = (
            (0.05 / (1 + i * 0.12)) * np.sin((i + 2.5) * np.pi * x + i)
            + 0.025 * np.cos((7 + i) * x)
            + rng.normal(0, 0.024 + i * 0.0015, n)
        )
        rows.append(base)
    rows.append(0.34 * first + 0.32 * second + rng.normal(0, 0.045, n))
    matrix = np.vstack(rows)
    matrix = np.apply_along_axis(_smooth, 1, matrix, 3)
    matrix = np.clip(matrix, -vmax, vmax)
    output = _smooth(output + rng.normal(0, 0.055, n), 5)
    return matrix, output


def draw_panel(
    fig: plt.Figure,
    spec,
    title: str,
    panel: str,
    features: list[str],
    n: int,
    vmax: float,
    kind: str,
    seed: int,
) -> None:
    sub = spec.subgridspec(
        2,
        3,
        height_ratios=[0.24, 0.76],
        width_ratios=[1.0, 0.042, 0.022],
        hspace=0.0,
        wspace=0.02,
    )
    ax_line = fig.add_subplot(sub[0, 0])
    ax_heat = fig.add_subplot(sub[1, 0])
    ax_imp = fig.add_subplot(sub[1, 1], sharey=ax_heat)
    cax = fig.add_subplot(sub[:, 2])

    matrix, output = simulate_decision_heatmap(n, vmax, kind, seed)
    cmap = LinearSegmentedColormap.from_list(
        "shap_blue_white_pink", ["#419cf3", "#f8fbfd", "#ff2d5f"], N=256
    )
    norm = TwoSlopeNorm(vmin=-vmax, vcenter=0, vmax=vmax)

    ax_line.plot(np.arange(n), output, color="black", lw=0.75)
    ax_line.axhline(np.mean(output), color="#bdbdbd", ls="--", lw=0.6)
    ax_line.set_xlim(0, n - 1)
    ax_line.set_xticks([])
    ax_line.set_yticks([])
    ax_line.set_title(title, fontsize=11, pad=10)
    ax_line.text(
        -0.12,
        0.78,
        f"({panel})",
        transform=ax_line.transAxes,
        fontsize=12,
        ha="left",
        va="center",
    )
    ax_line.text(
        -0.03,
        0.37,
        r"$f(x)$",
        transform=ax_line.transAxes,
        fontsize=9,
        ha="right",
        va="center",
    )
    for spine in ax_line.spines.values():
        spine.set_visible(False)

    im = ax_heat.imshow(matrix, aspect="auto", cmap=cmap, norm=norm, interpolation="nearest")
    ax_heat.set_yticks(np.arange(len(features)))
    ax_heat.set_yticklabels(features, fontsize=8.2)
    ax_heat.set_xlabel("Instances", fontsize=8)
    ax_heat.tick_params(axis="x", labelsize=7.5, length=3, width=0.7)
    ax_heat.tick_params(axis="y", length=3, width=0.7, pad=2)
    ax_heat.spines["left"].set_visible(False)
    ax_heat.spines["bottom"].set_visible(False)
    ax_heat.set_xlim(-0.5, n - 0.5)

    importance = np.mean(np.abs(matrix), axis=1)
    importance = importance / importance.max()
    ax_imp.barh(np.arange(len(features)), importance, color="black", height=0.72)
    ax_imp.set_xlim(0, 1.05)
    ax_imp.set_xticks([])
    ax_imp.tick_params(axis="y", left=False, labelleft=False)
    for spine in ax_imp.spines.values():
        spine.set_visible(False)

    cb = fig.colorbar(im, cax=cax, orientation="vertical", ticks=[-vmax, vmax])
    cb.outline.set_visible(False)
    cb.ax.tick_params(length=0, labelsize=7)
    cb.ax.set_yticklabels([f"{-vmax:.4g}", f"{vmax:.4g}"])
    cb.set_label("SHAP value (impact on model output)", fontsize=7.5, labelpad=7)


def make_figure(output_stem: Path = OUTPUT) -> None:
    """Reproduce the paired SHAP decision-heatmap structure with synthetic data."""
    configure_matplotlib()
    fig = plt.figure(figsize=(13.2, 4.05), facecolor="white")
    outer = fig.add_gridspec(1, 2, left=0.105, right=0.970, top=0.90, bottom=0.14, wspace=0.38)
    draw_panel(fig, outer[0], "Igneous", "a", FEATURES_IGNEOUS, 162, 0.3, "igneous", 9021)
    draw_panel(
        fig,
        outer[1],
        "Sedimentary",
        "b",
        FEATURES_SEDIMENTARY,
        324,
        0.3553,
        "sedimentary",
        9022,
    )
    output_stem.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(output_stem.with_suffix(".png"), dpi=300, facecolor="white")
    fig.savefig(output_stem.with_suffix(".pdf"), facecolor="white")
    fig.savefig(output_stem.with_suffix(".svg"), facecolor="white")
    plt.close(fig)


def main() -> None:
    make_figure()


if __name__ == "__main__":
    main()
