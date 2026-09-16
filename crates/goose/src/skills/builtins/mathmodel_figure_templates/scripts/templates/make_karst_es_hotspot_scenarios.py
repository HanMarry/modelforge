from __future__ import annotations

import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("MPLCONFIGDIR", str(ROOT / ".mplconfig"))

import matplotlib as mpl

mpl.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.colors import BoundaryNorm, ListedColormap
from matplotlib.path import Path as MplPath
import numpy as np
from scipy.ndimage import gaussian_filter


BOUNDARY_FILE = ROOT / "data" / "karst_southeast_yunnan_boundary.json"
SCENARIOS = ["2035 SSP126", "2035 SSP245", "2035 SSP585"]
HOTSPOT_COLORS = ["#3F6FB3", "#7894B9", "#B8C4C4", "#FFF7BF",
                  "#F6BC88", "#EA755C", "#D73027"]
HOTSPOT_CMAP = ListedColormap(HOTSPOT_COLORS)
HOTSPOT_NORM = BoundaryNorm(np.arange(-3.5, 4.5, 1), HOTSPOT_CMAP.N)


def configure_matplotlib() -> None:
    mpl.rcParams.update({
        "font.family": "sans-serif",
        "font.sans-serif": ["Arial", "Helvetica", "DejaVu Sans", "sans-serif"],
        "font.size": 8,
        "svg.fonttype": "none",
        "pdf.fonttype": 42,
        "axes.linewidth": 0.7,
    })


def load_boundary() -> tuple[np.ndarray, tuple[float, float, float, float]]:
    payload = json.loads(BOUNDARY_FILE.read_text(encoding="utf-8"))
    return np.asarray(payload["outline"][0], dtype=float), tuple(payload["bounds"])


def make_grid(ring: np.ndarray, bounds: tuple[float, float, float, float],
              nx: int = 470, ny: int = 310) -> tuple[np.ndarray, np.ndarray, np.ndarray, tuple[float, float, float, float]]:
    xmin, ymin, xmax, ymax = bounds
    padx, pady = 0.035 * (xmax - xmin), 0.045 * (ymax - ymin)
    extent = (xmin - padx, xmax + padx, ymin - pady, ymax + pady)
    x = np.linspace(extent[0], extent[1], nx)
    y = np.linspace(extent[2], extent[3], ny)
    xx, yy = np.meshgrid(x, y)
    mask = MplPath(ring).contains_points(np.c_[xx.ravel(), yy.ravel()]).reshape(ny, nx)
    return xx, yy, mask, extent


def normalize(values: np.ndarray) -> np.ndarray:
    lo, hi = np.nanpercentile(values, [1, 99])
    return np.clip((values - lo) / max(hi - lo, 1e-8), 0, 1)


def simulate_scenarios(ring: np.ndarray, bounds: tuple[float, float, float, float]) -> tuple[list[np.ndarray], list[np.ndarray], tuple[float, float, float, float]]:
    """Deterministic scenario fields reproducing structure, not study measurements."""
    xx, yy, mask, extent = make_grid(ring, bounds)
    xn = (xx - xx.min()) / (xx.max() - xx.min())
    yn = (yy - yy.min()) / (yy.max() - yy.min())
    rng = np.random.default_rng(6316605)
    coarse = gaussian_filter(rng.normal(size=xx.shape), 25)
    medium = gaussian_filter(rng.normal(size=xx.shape), 8)
    fine = gaussian_filter(rng.normal(size=xx.shape), 2.0)
    texture = normalize(0.70 * coarse + 0.22 * medium + 0.08 * fine)
    ridges = normalize(0.48 * texture + 0.20 * np.sin(11 * xn + 4 * yn)
                       + 0.17 * np.cos(15 * yn - 2 * xn) + 0.15 * (1 - yn))
    moisture = normalize(0.54 * (1 - yn) + 0.21 * (1 - xn)
                         + 0.25 * gaussian_filter(rng.random(xx.shape), 12))

    urban = np.zeros_like(xx)
    for cx, cy, scale, amp in [(0.28, 0.69, 0.05, 1.0),
                               (0.43, 0.42, 0.045, 0.9),
                               (0.62, 0.39, 0.04, 0.8),
                               (0.77, 0.52, 0.038, 0.75)]:
        urban += amp * np.exp(-((xn - cx) ** 2 + (yn - cy) ** 2) / (2 * scale ** 2))
    urban = normalize(urban + 0.10 * gaussian_filter(rng.random(xx.shape), 5))

    total_fields: list[np.ndarray] = []
    hotspot_fields: list[np.ndarray] = []
    specs = [
        (0.10, 0.19, 0.10, -0.03),
        (0.06, 0.29, 0.18, 0.02),
        (-0.03, 0.47, 0.30, 0.08),
    ]
    for scenario_idx, (gain, urban_pressure, fragmentation, east_shift) in enumerate(specs):
        total = normalize(0.38 * moisture + 0.33 * ridges + 0.29 * texture
                          - urban_pressure * urban
                          - fragmentation * np.maximum(0, fine))
        total = np.clip(total + gain + east_shift * xn, 0, 1)

        local = gaussian_filter(np.where(mask, total, np.nanmean(total[mask])), 7)
        hot_score = (1.48 * (0.50 - yn) + 0.52 * (local - 0.5)
                     - (0.50 + 0.18 * scenario_idx) * urban
                     + 0.18 * np.sin(8 * xn + 2 * scenario_idx)
                     + 0.11 * gaussian_filter(rng.normal(size=xx.shape), 10))
        if scenario_idx == 1:
            hot_score += 0.28 * np.exp(-((xn - 0.25) ** 2 + (yn - 0.42) ** 2) / 0.035)
        if scenario_idx == 2:
            hot_score -= 0.20 * np.exp(-((xn - 0.47) ** 2 + (yn - 0.55) ** 2) / 0.05)
        hotspot = np.digitize(hot_score, [-0.62, -0.34, -0.12, 0.12, 0.34, 0.62]) - 3

        total_fields.append(np.where(mask, total, np.nan))
        hotspot_fields.append(np.where(mask, hotspot, np.nan))
    return total_fields, hotspot_fields, extent


def draw_map(ax: plt.Axes, data: np.ndarray, extent: tuple[float, float, float, float],
             ring: np.ndarray, cmap, norm=None, vmin=None, vmax=None) -> None:
    ax.imshow(data, origin="lower", extent=extent, cmap=cmap, norm=norm,
              vmin=vmin, vmax=vmax, interpolation="bilinear" if norm is None else "nearest",
              rasterized=True)
    ax.plot(ring[:, 0], ring[:, 1], color="#34433D", lw=0.48, alpha=0.75)
    ax.set_aspect("equal")
    ax.set_axis_off()


def draw_scale_bar(ax: plt.Axes) -> None:
    ax.plot([0.03, 0.25], [0.01, 0.01], transform=ax.transAxes,
            color="#202020", lw=1.0, clip_on=False)
    for x in (0.03, 0.25):
        ax.plot([x, x], [0.005, 0.025], transform=ax.transAxes,
                color="#202020", lw=0.8, clip_on=False)
    ax.text(0.03, -0.025, "0", transform=ax.transAxes, ha="center", va="top", fontsize=6.5)
    ax.text(0.25, -0.025, "150 km", transform=ax.transAxes, ha="center", va="top", fontsize=6.5)


def make_figure(output_stem: Path) -> None:
    configure_matplotlib()
    ring, bounds = load_boundary()
    totals, hotspots, extent = simulate_scenarios(ring, bounds)

    fig, axes = plt.subplots(2, 3, figsize=(12.0, 8.25), facecolor="white")
    fig.subplots_adjust(left=0.025, right=0.99, top=0.94, bottom=0.12,
                        wspace=0.035, hspace=0.30)
    for col, scenario in enumerate(SCENARIOS):
        draw_map(axes[0, col], totals[col], extent, ring, "YlGn", vmin=0, vmax=1)
        draw_map(axes[1, col], hotspots[col], extent, ring,
                 HOTSPOT_CMAP, norm=HOTSPOT_NORM)
        axes[0, col].set_title(scenario, fontsize=11.0, fontweight="bold", pad=2)
        axes[1, col].set_title(scenario, fontsize=10.5, fontweight="bold", pad=2)

    axes[0, 0].annotate("", xy=(0.075, 0.98), xytext=(0.075, 0.82),
                        xycoords="axes fraction", textcoords="axes fraction",
                        arrowprops=dict(arrowstyle="-|>", lw=0.9, color="#202020"))
    axes[0, 0].text(0.075, 1.005, "N", transform=axes[0, 0].transAxes,
                    ha="center", va="bottom", fontsize=9, fontweight="bold")
    draw_scale_bar(axes[1, 0])

    total_mappable = mpl.cm.ScalarMappable(norm=mpl.colors.Normalize(0, 1), cmap="YlGn")
    total_cax = fig.add_axes([0.36, 0.515, 0.28, 0.022])
    total_cb = fig.colorbar(total_mappable, cax=total_cax, orientation="horizontal")
    total_cb.set_ticks([0, 1])
    total_cb.set_ticklabels(["0", "1"])
    total_cb.ax.tick_params(length=0, labelsize=7)
    total_cb.outline.set_visible(False)
    fig.text(0.345, 0.526, "Total ES", ha="right", va="center",
             fontsize=9.2, fontweight="bold")

    hotspot_mappable = mpl.cm.ScalarMappable(norm=HOTSPOT_NORM, cmap=HOTSPOT_CMAP)
    hot_cax = fig.add_axes([0.34, 0.055, 0.36, 0.022])
    hot_cb = fig.colorbar(hotspot_mappable, cax=hot_cax, orientation="horizontal",
                          ticks=np.arange(-3, 4))
    hot_cb.ax.tick_params(length=0, labelsize=7)
    hot_cb.outline.set_visible(False)
    fig.text(0.325, 0.066, "Getis–Ord Gi*", ha="right", va="center",
             fontsize=9.2, fontweight="bold")

    output_stem.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(output_stem.with_suffix(".png"), dpi=300, bbox_inches="tight",
                facecolor="white")
    fig.savefig(output_stem.with_suffix(".pdf"), bbox_inches="tight",
                facecolor="white")
    fig.savefig(output_stem.with_suffix(".svg"), bbox_inches="tight",
                facecolor="white")
    fig.savefig(output_stem.with_suffix(".tiff"), dpi=600, bbox_inches="tight",
                facecolor="white", pil_kwargs={"compression": "tiff_lzw"})
    plt.close(fig)


def main() -> None:
    make_figure(ROOT / "outputs" / "karst_es_hotspot_scenarios_replica")


if __name__ == "__main__":
    main()
