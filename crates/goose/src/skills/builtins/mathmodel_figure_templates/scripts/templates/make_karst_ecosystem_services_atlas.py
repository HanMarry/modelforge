from __future__ import annotations

import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("MPLCONFIGDIR", str(ROOT / ".mplconfig"))

import matplotlib as mpl

mpl.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.path import Path as MplPath
import numpy as np
from scipy.ndimage import gaussian_filter


BOUNDARY_FILE = ROOT / "data" / "karst_southeast_yunnan_boundary.json"
ROW_LABELS = ["2000", "2005", "2010", "2015", "2020",
              "2035 SSP126", "2035 SSP245", "2035 SSP585"]
METRICS = [
    ("Water yield\n(m³ hm$^{-2}$)", "Blues", 17897),
    ("Carbon storage\n(t hm$^{-2}$)", "YlGnBu", 23),
    ("Habitat quality", "BuGn", 1),
    ("Soil retention\n(t hm$^{-2}$)", "Purples", 1200),
]


def configure_matplotlib() -> None:
    mpl.rcParams.update({
        "font.family": "sans-serif",
        "font.sans-serif": ["Arial", "Helvetica", "DejaVu Sans", "sans-serif"],
        "font.size": 6.6,
        "svg.fonttype": "none",
        "pdf.fonttype": 42,
        "axes.linewidth": 0.6,
    })


def load_boundary() -> tuple[np.ndarray, tuple[float, float, float, float]]:
    payload = json.loads(BOUNDARY_FILE.read_text(encoding="utf-8"))
    return np.asarray(payload["outline"][0], dtype=float), tuple(payload["bounds"])


def make_grid(ring: np.ndarray, bounds: tuple[float, float, float, float],
              nx: int = 410, ny: int = 270) -> tuple[np.ndarray, np.ndarray, np.ndarray, tuple[float, float, float, float]]:
    xmin, ymin, xmax, ymax = bounds
    pad_x, pad_y = 0.025 * (xmax - xmin), 0.035 * (ymax - ymin)
    extent = (xmin - pad_x, xmax + pad_x, ymin - pad_y, ymax + pad_y)
    x = np.linspace(extent[0], extent[1], nx)
    y = np.linspace(extent[2], extent[3], ny)
    xx, yy = np.meshgrid(x, y)
    mask = MplPath(ring).contains_points(np.c_[xx.ravel(), yy.ravel()]).reshape(ny, nx)
    return xx, yy, mask, extent


def normalize(values: np.ndarray) -> np.ndarray:
    lo, hi = np.nanpercentile(values, [1, 99])
    return np.clip((values - lo) / max(hi - lo, 1e-8), 0, 1)


def gaussian_surface(xn: np.ndarray, yn: np.ndarray,
                     centers: list[tuple[float, float, float, float]]) -> np.ndarray:
    surface = np.zeros_like(xn)
    for cx, cy, scale, amp in centers:
        surface += amp * np.exp(-((xn - cx) ** 2 + (yn - cy) ** 2) / (2 * scale ** 2))
    return surface


def simulate_fields(ring: np.ndarray, bounds: tuple[float, float, float, float]) -> tuple[list[list[np.ndarray]], tuple[float, float, float, float]]:
    """Deterministic spatial reconstructions; values are not source measurements."""
    xx, yy, mask, extent = make_grid(ring, bounds)
    xn = (xx - xx.min()) / (xx.max() - xx.min())
    yn = (yy - yy.min()) / (yy.max() - yy.min())
    rng = np.random.default_rng(4316605)
    coarse = gaussian_filter(rng.normal(size=xx.shape), 28)
    medium = gaussian_filter(rng.normal(size=xx.shape), 9)
    fine = gaussian_filter(rng.normal(size=xx.shape), 2.1)
    texture = normalize(0.68 * coarse + 0.24 * medium + 0.08 * fine)
    ridges = normalize(0.58 * texture + 0.20 * np.sin(10 * xn + 4 * yn)
                       + 0.12 * np.cos(16 * yn - 3 * xn) + 0.10 * (1 - yn))
    wetness = normalize(0.52 * (1 - yn) + 0.22 * (1 - xn)
                        + 0.26 * gaussian_filter(rng.random(xx.shape), 13))
    urban = gaussian_surface(xn, yn, [
        (0.28, 0.69, 0.045, 1.0), (0.43, 0.42, 0.045, 0.95),
        (0.62, 0.39, 0.040, 0.88), (0.76, 0.51, 0.038, 0.78),
    ])
    urban = normalize(urban + 0.11 * gaussian_filter(rng.random(xx.shape), 5))

    rows: list[list[np.ndarray]] = []
    history_delta = [-0.025, -0.010, 0.000, 0.018, 0.032]
    scenario_specs = [
        (0.065, -0.010, -0.012, 0.070, 0.15),
        (0.045, -0.035, -0.040, 0.055, 0.24),
        (0.015, -0.075, -0.085, 0.015, 0.42),
    ]

    for delta in history_delta:
        water = normalize(0.53 * wetness + 0.25 * texture + 0.16 * (1 - yn)
                          + 0.06 * np.sin(18 * xn)) + delta
        carbon = normalize(0.55 * ridges + 0.25 * wetness + 0.20 * texture
                           - 0.24 * urban) + 0.20 * delta
        habitat = normalize(0.48 * carbon + 0.30 * wetness + 0.22 * ridges
                            - 0.38 * urban) + 0.10 * delta
        slope_proxy = normalize(np.hypot(*np.gradient(ridges)))
        soil = normalize(0.46 * slope_proxy + 0.28 * wetness + 0.26 * ridges) + 0.28 * delta
        rows.append([water, carbon, habitat, soil])

    for water_d, carbon_d, habitat_d, soil_d, urban_pressure in scenario_specs:
        water = normalize(0.53 * wetness + 0.25 * texture + 0.16 * (1 - yn)
                          + 0.06 * np.sin(18 * xn)) + water_d
        carbon = normalize(0.55 * ridges + 0.25 * wetness + 0.20 * texture
                           - (0.24 + urban_pressure) * urban) + carbon_d
        habitat = normalize(0.48 * carbon + 0.30 * wetness + 0.22 * ridges
                            - (0.38 + urban_pressure) * urban) + habitat_d
        slope_proxy = normalize(np.hypot(*np.gradient(ridges)))
        soil = normalize(0.46 * slope_proxy + 0.28 * wetness + 0.26 * ridges) + soil_d
        rows.append([water, carbon, habitat, soil])

    for row in rows:
        for idx, field in enumerate(row):
            row[idx] = np.where(mask, np.clip(field, 0, 1), np.nan)
    return rows, extent


def draw_scale_bar(ax: plt.Axes) -> None:
    ax.plot([0.06, 0.31], [0.02, 0.02], transform=ax.transAxes, color="#262626",
            lw=1.0, clip_on=False)
    ax.plot([0.06, 0.06], [0.015, 0.033], transform=ax.transAxes,
            color="#262626", lw=0.8, clip_on=False)
    ax.plot([0.31, 0.31], [0.015, 0.033], transform=ax.transAxes,
            color="#262626", lw=0.8, clip_on=False)
    ax.text(0.06, -0.01, "0", transform=ax.transAxes, ha="center", va="top", fontsize=5.8)
    ax.text(0.31, -0.01, "150 km", transform=ax.transAxes, ha="center", va="top", fontsize=5.8)


def make_figure(output_stem: Path) -> None:
    configure_matplotlib()
    ring, bounds = load_boundary()
    rows, extent = simulate_fields(ring, bounds)

    fig, axes = plt.subplots(8, 4, figsize=(10.1, 18.8), facecolor="white")
    fig.subplots_adjust(left=0.025, right=0.992, top=0.985, bottom=0.025,
                        wspace=0.055, hspace=0.19)

    for r, row_label in enumerate(ROW_LABELS):
        for c, (metric_label, cmap, vmax_display) in enumerate(METRICS):
            ax = axes[r, c]
            image = ax.imshow(rows[r][c], origin="lower", extent=extent,
                              cmap=cmap, vmin=0, vmax=1, interpolation="bilinear",
                              rasterized=True)
            ax.plot(ring[:, 0], ring[:, 1], color="#31423D", lw=0.32, alpha=0.65)
            ax.set_aspect("equal")
            ax.set_axis_off()
            ax.set_title(row_label, fontsize=7.7, fontweight="bold", pad=1.0)

            cax = ax.inset_axes([0.44, -0.012, 0.48, 0.055])
            cb = fig.colorbar(image, cax=cax, orientation="horizontal")
            cb.set_ticks([0, 1])
            cb.set_ticklabels(["0", f"{vmax_display:g}"])
            cb.ax.tick_params(labelsize=5.0, length=0, pad=1)
            cb.outline.set_visible(False)
            ax.text(0.41, 0.016, metric_label, transform=ax.transAxes,
                    ha="right", va="center", fontsize=5.7, fontweight="bold")

            if r == 0 and c == 0:
                ax.annotate("", xy=(0.08, 0.96), xytext=(0.08, 0.81),
                            xycoords="axes fraction", textcoords="axes fraction",
                            arrowprops=dict(arrowstyle="-|>", color="#202020", lw=0.8))
                ax.text(0.08, 0.985, "N", transform=ax.transAxes, ha="center",
                        va="bottom", fontsize=7.5, fontweight="bold")

    output_stem.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(output_stem.with_suffix(".png"), dpi=260, bbox_inches="tight",
                facecolor="white")
    fig.savefig(output_stem.with_suffix(".pdf"), bbox_inches="tight",
                facecolor="white")
    fig.savefig(output_stem.with_suffix(".svg"), bbox_inches="tight",
                facecolor="white")
    fig.savefig(output_stem.with_suffix(".tiff"), dpi=500, bbox_inches="tight",
                facecolor="white", pil_kwargs={"compression": "tiff_lzw"})
    plt.close(fig)


def main() -> None:
    make_figure(ROOT / "outputs" / "karst_ecosystem_services_atlas_replica")


if __name__ == "__main__":
    main()
