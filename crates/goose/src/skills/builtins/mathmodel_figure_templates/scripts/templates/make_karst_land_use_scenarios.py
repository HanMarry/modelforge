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
from matplotlib.patches import ConnectionPatch, Patch, Rectangle
from matplotlib.path import Path as MplPath
import numpy as np
from scipy.ndimage import gaussian_filter


BOUNDARY_FILE = ROOT / "data" / "karst_southeast_yunnan_boundary.json"
CLASS_NAMES = ["Farmland", "Forest", "Grassland", "Water", "Built-up land", "Unused land"]
CLASS_COLORS = ["#F2E62A", "#287A22", "#24C92D", "#176CC4", "#E42A20", "#CFCFCF"]
LAND_CMAP = ListedColormap(CLASS_COLORS)
LAND_NORM = BoundaryNorm(np.arange(-0.5, 6.5, 1), LAND_CMAP.N)


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
    ring = np.asarray(payload["outline"][0], dtype=float)
    return ring, tuple(payload["bounds"])


def make_grid(ring: np.ndarray, bounds: tuple[float, float, float, float],
              nx: int = 520, ny: int = 330) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    xmin, ymin, xmax, ymax = bounds
    pad_x, pad_y = 0.04 * (xmax - xmin), 0.04 * (ymax - ymin)
    extent = (xmin - pad_x, xmax + pad_x, ymin - pad_y, ymax + pad_y)
    x = np.linspace(extent[0], extent[1], nx)
    y = np.linspace(extent[2], extent[3], ny)
    xx, yy = np.meshgrid(x, y)
    mask = MplPath(ring).contains_points(np.c_[xx.ravel(), yy.ravel()]).reshape(ny, nx)
    return xx, yy, mask


def _normalize(values: np.ndarray) -> np.ndarray:
    lo, hi = np.nanpercentile(values, [1, 99])
    return np.clip((values - lo) / max(hi - lo, 1e-8), 0, 1)


def simulate_land_use(ring: np.ndarray, bounds: tuple[float, float, float, float],
                      scenario_idx: int) -> tuple[np.ndarray, tuple[float, float, float, float]]:
    """Rebuild the paper's visual logic with deterministic replacement fields."""
    xx, yy, mask = make_grid(ring, bounds)
    rng = np.random.default_rng(316605)
    coarse = gaussian_filter(rng.normal(size=xx.shape), 23)
    medium = gaussian_filter(rng.normal(size=xx.shape), 7)
    fine = gaussian_filter(rng.normal(size=xx.shape), 1.7)
    texture = _normalize(0.70 * coarse + 0.22 * medium + 0.08 * fine)

    xn = (xx - xx.min()) / (xx.max() - xx.min())
    yn = (yy - yy.min()) / (yy.max() - yy.min())
    terrain = _normalize(0.65 * texture + 0.18 * (1 - yn) + 0.10 * np.sin(9 * xn + 5 * yn))
    moisture = _normalize(0.55 * (1 - yn) + 0.25 * texture + 0.20 * np.cos(7 * xn - 3 * yn))

    urban_core = np.zeros_like(xx)
    centers = [(0.28, 0.69, 0.043), (0.43, 0.42, 0.040),
               (0.62, 0.38, 0.038), (0.75, 0.52, 0.032)]
    intensity = [0.90, 1.02, 1.16][scenario_idx]
    for cx, cy, scale in centers:
        urban_core += np.exp(-((xn - cx) ** 2 + (yn - cy) ** 2) / (2 * scale ** 2))
    urban = _normalize(
        intensity * urban_core
        + 0.20 * _normalize(medium)
        + 0.12 * _normalize(fine)
    )

    river_center = 0.34 + 0.06 * np.sin(7.5 * xn) + 0.025 * np.sin(19 * xn)
    water = np.abs(yn - river_center) < (0.0045 + 0.003 * texture)
    water |= ((moisture > 0.79) & (terrain < 0.36) & (fine > 0))

    classes = np.full(xx.shape, 1, dtype=float)  # forest
    farmland_score = 0.64 * (1 - terrain) + 0.25 * texture + 0.11 * xn
    classes[farmland_score > [0.54, 0.56, 0.58][scenario_idx]] = 0
    classes[(terrain < 0.50) & (moisture < 0.52) & (texture > 0.47)] = 2
    classes[(terrain > 0.86) & (moisture < 0.32)] = 5
    classes[water] = 3
    built_threshold = [0.78, 0.73, 0.66][scenario_idx]
    classes[(urban > built_threshold) & ~water] = 4
    classes[~mask] = np.nan
    return classes, (xx.min(), xx.max(), yy.min(), yy.max())


def draw_map(ax: plt.Axes, data: np.ndarray, extent: tuple[float, float, float, float],
             ring: np.ndarray, crop: tuple[float, float, float, float] | None = None,
             outline_lw: float = 0.55) -> None:
    ax.imshow(data, origin="lower", extent=extent, cmap=LAND_CMAP, norm=LAND_NORM,
              interpolation="nearest", rasterized=True)
    ax.plot(ring[:, 0], ring[:, 1], color="#263238", lw=outline_lw, zorder=4)
    if crop is None:
        ax.set_xlim(extent[0], extent[1])
        ax.set_ylim(extent[2], extent[3])
    else:
        ax.set_xlim(crop[0], crop[2])
        ax.set_ylim(crop[1], crop[3])
    ax.set_aspect("equal")
    ax.set_axis_off()


def make_figure(output_stem: Path) -> None:
    configure_matplotlib()
    ring, bounds = load_boundary()
    scenarios = ["SSP126", "SSP245", "SSP585"]
    maps = [simulate_land_use(ring, bounds, i) for i in range(3)]

    xmin, ymin, xmax, ymax = bounds
    crops = [
        (xmin + 0.40 * (xmax - xmin), ymin + 0.70 * (ymax - ymin),
         xmin + 0.60 * (xmax - xmin), ymin + 0.94 * (ymax - ymin)),
        (xmin + 0.27 * (xmax - xmin), ymin + 0.24 * (ymax - ymin),
         xmin + 0.46 * (xmax - xmin), ymin + 0.45 * (ymax - ymin)),
        (xmin + 0.52 * (xmax - xmin), ymin + 0.22 * (ymax - ymin),
         xmin + 0.72 * (xmax - xmin), ymin + 0.45 * (ymax - ymin)),
    ]

    fig = plt.figure(figsize=(15.2, 6.35), facecolor="white")
    for col, (scenario, (data, extent)) in enumerate(zip(scenarios, maps)):
        x0 = 0.014 + col * 0.329
        main_ax = fig.add_axes([x0 + 0.025, 0.29, 0.275, 0.47])
        draw_map(main_ax, data, extent, ring, outline_lw=0.50)
        main_ax.text(0.00, 1.03, f"{chr(97 + col)}. {scenario}", transform=main_ax.transAxes,
                     ha="left", va="bottom", fontsize=11.5)

        inset_positions = [
            [x0 + 0.205, 0.68, 0.115, 0.255],
            [x0 + 0.000, 0.075, 0.122, 0.245],
            [x0 + 0.198, 0.075, 0.122, 0.245],
        ]
        labels = [f"{chr(97 + col)}1", f"{chr(97 + col)}3", f"{chr(97 + col)}2"]
        for crop_idx, (crop, pos, label) in enumerate(zip(crops, inset_positions, labels)):
            rect = Rectangle((crop[0], crop[1]), crop[2] - crop[0], crop[3] - crop[1],
                             fill=False, ec="#31343B", lw=0.75, zorder=7)
            main_ax.add_patch(rect)
            inset = fig.add_axes(pos)
            draw_map(inset, data, extent, ring, crop=crop, outline_lw=0.22)
            for spine in inset.spines.values():
                spine.set_visible(True)
                spine.set_color("#333333")
                spine.set_linewidth(0.75)
            inset.text(0.02, 0.97, f"({label})", transform=inset.transAxes,
                       ha="left", va="top", fontsize=8.4, fontweight="bold")

            source_point = ((crop[0] + crop[2]) / 2,
                            crop[3] if crop_idx == 0 else crop[1])
            target_point = (0.06 if crop_idx != 2 else 0.94,
                            0.08 if crop_idx == 0 else 0.94)
            connector = ConnectionPatch(
                xyA=source_point, coordsA=main_ax.transData,
                xyB=target_point, coordsB=inset.transAxes,
                color="#3F4650", lw=0.65, zorder=6,
            )
            fig.add_artist(connector)

    handles = [Patch(facecolor=color, edgecolor="none", label=name)
               for name, color in zip(CLASS_NAMES, CLASS_COLORS)]
    legend = fig.legend(handles=handles, loc="lower center", ncol=6,
                        bbox_to_anchor=(0.5, 0.005), frameon=False,
                        handlelength=2.4, handleheight=1.05, columnspacing=1.65,
                        fontsize=9.2, title="Land-use types")
    legend.get_title().set_fontsize(9.6)
    legend.get_title().set_fontweight("bold")

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
    make_figure(ROOT / "outputs" / "karst_land_use_scenarios_replica")


if __name__ == "__main__":
    main()
