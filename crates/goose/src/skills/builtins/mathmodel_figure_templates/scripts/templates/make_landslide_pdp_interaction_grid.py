from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("MPLCONFIGDIR", str(ROOT / ".mplconfig"))

import matplotlib as mpl

mpl.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.colors import BoundaryNorm, ListedColormap
from scipy.ndimage import gaussian_filter


OUTPUT = (
    ROOT / "outputs" / "10-1038-s44304-025-00146-8" / "figure-10" / "landslide_pdp_interaction_grid_replica"
    if (ROOT / "sources" / "10-1038-s44304-025-00146-8").exists()
    else ROOT / "outputs" / "landslide_pdp_interaction_grid_replica"
)
CMAP = ListedColormap(
    ["#3346a8", "#5c8fd1", "#a9d5df", "#f5f7c6", "#f5d78a", "#ef946f", "#d95a62", "#8e1638"]
)
BOUNDS = np.array([0.0, 0.43, 0.46, 0.49, 0.51, 0.54, 0.56, 0.60, 1.0])
NORM = BoundaryNorm(BOUNDS, CMAP.N)


def configure_matplotlib() -> None:
    mpl.rcParams.update(
        {
            "font.family": "sans-serif",
            "font.sans-serif": ["Arial", "Helvetica", "DejaVu Sans", "sans-serif"],
            "font.size": 8,
            "axes.linewidth": 0.85,
            "axes.spines.right": True,
            "axes.spines.top": True,
            "svg.fonttype": "none",
            "pdf.fonttype": 42,
        }
    )


def _rug(ax: plt.Axes, values: np.ndarray, ymin: float, ymax: float) -> None:
    h = (ymax - ymin) * 0.038
    ax.vlines(values, ymin, ymin + h, color="black", lw=0.8)


def simulate_pdp(seed: int = 1010) -> dict[str, tuple[np.ndarray, np.ndarray, np.ndarray]]:
    rng = np.random.default_rng(seed)
    wc = np.linspace(23.9, 26.45, 54)
    coh = np.linspace(25.2, 35.0, 54)
    sh = np.linspace(7.8, 22.0, 54)
    y_wc = (
        0.557
        - 0.004 * (wc - 24.0)
        - 0.010 / (1 + np.exp(-(wc - 25.62) * 24))
        - 0.018 / (1 + np.exp(-(wc - 25.75) * 16))
        - 0.078 / (1 + np.exp(-(wc - 26.32) * 35))
    )
    y_coh = (
        0.508
        - 0.007 * np.exp(-((coh - 26.5) / 0.8) ** 2)
        + 0.033 / (1 + np.exp(-(coh - 28.6) * 3.3))
        + 0.010 * (coh - 29) / 8
    )
    y_sh = (
        0.506
        - 0.007 * np.exp(-((sh - 9.5) / 0.7) ** 2)
        + 0.033 / (1 + np.exp(-(sh - 11.9) * 2.6))
        + 0.006 * np.sin(sh * 1.7) * np.exp(-((sh - 14) / 5) ** 2)
        + 0.021 / (1 + np.exp(-(sh - 21.3) * 6))
    )
    for arr in (y_wc, y_coh, y_sh):
        arr += gaussian_filter(rng.normal(0, 0.0015, arr.size), 0.9)
    rugs = {
        "wc": np.array([24.2, 24.6, 25.05, 25.28, 25.60, 25.74, 25.86, 26.10, 26.25, 26.38]),
        "coh": np.array([26.0, 26.7, 27.9, 28.2, 28.9, 29.8, 30.3, 31.7, 34.3]),
        "sh": np.array([9.0, 10.0, 11.2, 12.1, 12.9, 13.6, 14.3, 15.6, 16.4, 19.7, 21.5]),
    }
    return {
        "wc": (wc, y_wc, rugs["wc"]),
        "coh": (coh, y_coh, rugs["coh"]),
        "sh": (sh, y_sh, rugs["sh"]),
    }


def _surface(
    x: np.ndarray, y: np.ndarray, pair: str, seed: int
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    xx, yy = np.meshgrid(x, y)
    if pair == "wc_coh":
        zz = (
            0.51
            + 0.055 / (1 + np.exp(-(yy - 28.9) * 1.2))
            - 0.12 / (1 + np.exp(-(26.25 - xx) * -16))
            + 0.018 * np.sin((yy - 25) * 0.7)
        )
    elif pair == "wc_sh":
        zz = (
            0.505
            + 0.055 / (1 + np.exp(-(yy - 11.4) * 0.9))
            - 0.115 / (1 + np.exp(-(26.23 - xx) * -18))
            + 0.012 * np.cos((yy - 12) * 1.3)
        )
    else:
        zz = (
            0.50
            + 0.045 / (1 + np.exp(-(xx - 28.7) * 1.2))
            + 0.045 / (1 + np.exp(-(yy - 12.0) * 1.0))
            + 0.012 * np.sin(xx * 0.8) * np.cos(yy * 0.55)
        )
    rng = np.random.default_rng(seed)
    zz = gaussian_filter(zz + rng.normal(0, 0.004, zz.shape), 1.6)
    return xx, yy, np.clip(zz, 0.42, 0.58)


def draw_top(
    ax: plt.Axes,
    x: np.ndarray,
    y: np.ndarray,
    rug: np.ndarray,
    xlabel: str,
    show_ylabel: bool,
) -> None:
    ax.plot(x, y, color="#4c76b6", lw=1.25)
    ax.set_ylim(0.445, 0.562)
    _rug(ax, rug, 0.445, 0.562)
    ax.set_xlabel(xlabel, fontsize=9)
    if show_ylabel:
        ax.set_ylabel("Partial dependence", fontsize=9)
        ax.set_yticks([0.46, 0.48, 0.50, 0.52, 0.54, 0.56])
    else:
        ax.set_yticks([])
    ax.tick_params(labelsize=8, length=3, width=0.8)


def draw_bottom(
    fig: plt.Figure,
    ax: plt.Axes,
    cax: plt.Axes,
    x: np.ndarray,
    y: np.ndarray,
    pair: str,
    xlabel: str,
    ylabel: str,
    seed: int,
) -> None:
    xx, yy, zz = _surface(x, y, pair, seed)
    fill = ax.contourf(xx, yy, zz, levels=BOUNDS, cmap=CMAP, norm=NORM, extend="neither")
    levels = [0.43, 0.46, 0.49, 0.51, 0.54, 0.56]
    cs = ax.contour(xx, yy, zz, levels=levels, colors="#333333", linewidths=0.55)
    ax.clabel(cs, inline=True, fontsize=7, fmt="%.2f")
    ax.set_xlabel(xlabel, fontsize=9)
    ax.set_ylabel(ylabel, fontsize=9)
    ax.tick_params(labelsize=8, length=3, width=0.8)
    cbar = fig.colorbar(fill, cax=cax, ticks=np.arange(0, 1.01, 0.2), spacing="proportional")
    cbar.ax.tick_params(labelsize=8, length=3, width=0.7)
    cbar.outline.set_linewidth(0.8)


def make_figure(output_stem: Path = OUTPUT) -> None:
    """Reproduce the marginal-PDP and pairwise-interaction layout."""
    configure_matplotlib()
    data = simulate_pdp()
    fig = plt.figure(figsize=(11.3, 8.0), facecolor="white")
    gs = fig.add_gridspec(
        2,
        9,
        left=0.065,
        right=0.985,
        bottom=0.075,
        top=0.985,
        height_ratios=[0.44, 0.56],
        width_ratios=[1, 0.05, 0.18, 1, 0.05, 0.18, 1, 0.05, 0.02],
        hspace=0.26,
        wspace=0.08,
    )
    top_axes = [fig.add_subplot(gs[0, i]) for i in (0, 3, 6)]
    draw_top(top_axes[0], *data["wc"], "Water Content", True)
    draw_top(top_axes[1], *data["coh"], "Cohesion", False)
    draw_top(top_axes[2], *data["sh"], "Slope Height", False)
    for i in (1, 2, 4, 5, 7, 8):
        fig.add_subplot(gs[0, i]).set_axis_off()

    ax1, ax2, ax3 = (fig.add_subplot(gs[1, i]) for i in (0, 3, 6))
    cax1, cax2, cax3 = (fig.add_subplot(gs[1, i]) for i in (1, 4, 7))
    for i in (2, 5, 8):
        fig.add_subplot(gs[1, i]).set_axis_off()
    draw_bottom(
        fig,
        ax1,
        cax1,
        np.linspace(23.9, 26.45, 80),
        np.linspace(25.0, 35.0, 80),
        "wc_coh",
        "Water Content",
        "Cohesion",
        1011,
    )
    draw_bottom(
        fig,
        ax2,
        cax2,
        np.linspace(23.9, 26.45, 80),
        np.linspace(8.0, 22.0, 80),
        "wc_sh",
        "Water Content",
        "Slope Height",
        1012,
    )
    draw_bottom(
        fig,
        ax3,
        cax3,
        np.linspace(25.0, 35.0, 80),
        np.linspace(8.0, 22.0, 80),
        "coh_sh",
        "Cohesion",
        "Slope Height",
        1013,
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
