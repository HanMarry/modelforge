from __future__ import annotations

import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("MPLCONFIGDIR", str(ROOT / ".mplconfig"))

import matplotlib as mpl

mpl.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.collections import PatchCollection
from matplotlib.colors import TwoSlopeNorm
from matplotlib.patches import Polygon
from matplotlib.path import Path as MplPath
from scipy.stats import gaussian_kde


WORLD = ROOT / "data" / "natural_earth_world_simplified.geojson"
OUTPUT = (
    ROOT / "outputs" / "10-1038-s43247-025-03048-9" / "figure-1" / "biodiversity_global_delta_atlas_replica"
    if (ROOT / "sources" / "10-1038-s43247-025-03048-9").exists()
    else ROOT / "outputs" / "biodiversity_global_delta_atlas_replica"
)


def configure_matplotlib() -> None:
    mpl.rcParams.update(
        {
            "font.family": "sans-serif",
            "font.sans-serif": ["Arial", "Helvetica", "DejaVu Sans", "sans-serif"],
            "font.size": 8,
            "axes.linewidth": 0.9,
            "axes.spines.right": True,
            "axes.spines.top": True,
            "svg.fonttype": "none",
            "pdf.fonttype": 42,
        }
    )


def load_world_rings(path: Path = WORLD) -> list[np.ndarray]:
    data = json.loads(path.read_text(encoding="utf-8"))
    rings: list[np.ndarray] = []
    for feature in data["features"]:
        geom = feature["geometry"]
        coordinates = geom["coordinates"]
        polygons = coordinates if geom["type"] == "MultiPolygon" else [coordinates]
        for polygon in polygons:
            if polygon:
                ring = np.asarray(polygon[0], dtype=float)
                if len(ring) >= 4:
                    rings.append(ring)
    return rings


def land_mask(points: np.ndarray, rings: list[np.ndarray]) -> np.ndarray:
    mask = np.zeros(len(points), dtype=bool)
    for ring in rings:
        if ring[:, 0].max() < -179 and ring[:, 0].min() > 179:
            continue
        mask |= MplPath(ring).contains_points(points)
    return mask


def draw_world(ax: plt.Axes, rings: list[np.ndarray], face: str = "#f7f7f7") -> None:
    patches = [Polygon(r, closed=True) for r in rings]
    ax.add_collection(
        PatchCollection(
            patches,
            facecolor=face,
            edgecolor="#262626",
            linewidth=0.42,
            zorder=1,
        )
    )


def simulate_forest_grid(
    rings: list[np.ndarray], seed: int = 4101
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    rng = np.random.default_rng(seed)
    lons = np.arange(-176, 177, 1.75)
    lats = np.arange(-52, 70, 1.75)
    lon2, lat2 = np.meshgrid(lons, lats)
    pts = np.column_stack([lon2.ravel(), lat2.ravel()])
    is_land = land_mask(pts, rings)
    lon, lat = pts[:, 0], pts[:, 1]

    score = np.zeros(len(pts))
    centers = [
        (-64, -5, 28, 18, 1.25),
        (23, 1, 23, 17, 1.10),
        (105, 12, 29, 20, 1.18),
        (-82, 39, 30, 16, 0.90),
        (18, 50, 38, 13, 0.78),
        (105, 52, 52, 14, 0.86),
        (-116, 55, 38, 13, 0.75),
    ]
    for x0, y0, sx, sy, amp in centers:
        score += amp * np.exp(-((lon - x0) / sx) ** 2 - ((lat - y0) / sy) ** 2)
    score += 0.20 * np.cos(np.deg2rad(lon * 2.5)) * np.cos(np.deg2rad(lat))
    score += rng.normal(0, 0.14, len(score))
    forest = is_land & (score > 0.46) & (lat > -48)

    zone_mean = np.where(np.abs(lat) <= 23, 0.54, np.where(lat >= 50, -0.03, 0.39))
    spatial = (
        0.38 * np.sin(np.deg2rad(lon * 2.1)) * np.cos(np.deg2rad(lat * 1.7))
        + 0.18 * np.cos(np.deg2rad(lon * 0.8 + lat * 3))
    )
    values = zone_mean + spatial + rng.normal(0, 0.34, len(score))
    values = np.clip(values, -2.8, 2.8)
    p_score = np.clip(np.abs(values) / 1.35 + rng.uniform(0, 0.35, len(values)), 0, 1.2)
    sizes = np.select(
        [p_score > 0.95, p_score > 0.68, p_score > 0.42],
        [10.5, 7.0, 4.3],
        default=2.2,
    )
    return pts[forest], values[forest], sizes[forest], score[forest]


def panel_label(ax: plt.Axes, label: str) -> None:
    ax.text(
        0.01,
        0.99,
        label,
        transform=ax.transAxes,
        ha="left",
        va="top",
        fontsize=12,
        fontweight="bold",
        zorder=20,
    )


def draw_map(
    fig: plt.Figure,
    ax: plt.Axes,
    rings: list[np.ndarray],
    points: np.ndarray,
    values: np.ndarray,
    sizes: np.ndarray,
) -> None:
    draw_world(ax, rings)
    zone_gray = np.where(
        points[:, 1] >= 50,
        "#b7b7b7",
        np.where(np.abs(points[:, 1]) <= 23, "#e4e4e4", "#cdcdcd"),
    )
    ax.scatter(points[:, 0], points[:, 1], s=11, c=zone_gray, marker="s", lw=0, zorder=2)
    norm = TwoSlopeNorm(vmin=-3, vcenter=0, vmax=3)
    sc = ax.scatter(
        points[:, 0],
        points[:, 1],
        c=values,
        s=sizes,
        cmap="RdBu_r",
        norm=norm,
        marker="o",
        lw=0,
        alpha=0.88,
        zorder=3,
    )
    draw_world(ax, rings, face="none")
    ax.set_xlim(-180, 180)
    ax.set_ylim(-55, 75)
    ax.set_xticks([-120, -60, 0, 60, 120])
    ax.set_yticks([-30, 0, 30, 60])
    ax.set_xlabel("Longitude(°)", fontsize=10)
    ax.set_ylabel("Latitude(°)", fontsize=10)
    ax.tick_params(labelsize=8, length=4, width=0.8)
    panel_label(ax, "a")

    cax = ax.inset_axes([0.065, 0.035, 0.014, 0.36])
    cb = fig.colorbar(sc, cax=cax, orientation="vertical", extend="both")
    cb.set_ticks([-3, -1.5, 0, 1.5, 3])
    cb.ax.tick_params(labelsize=7, length=3)
    cb.outline.set_linewidth(0.8)
    ax.text(0.063, 0.42, "ΔS(°C)", transform=ax.transAxes, fontsize=8, ha="left")

    ax.text(0.53, 0.105, r"$P$", transform=ax.transAxes, fontsize=8, fontstyle="italic")
    for x, s, label in zip(
        [0.585, 0.685, 0.775, 0.865], [10.5, 7.0, 4.3, 2.2], ["<0.001", "0.01", "0.05", ">0.05"]
    ):
        ax.scatter([x], [0.105], transform=ax.transAxes, s=s, c="black", clip_on=False)
        ax.text(x + 0.018, 0.105, label, transform=ax.transAxes, fontsize=7, va="center")


def draw_zonal(
    ax: plt.Axes, points: np.ndarray, values: np.ndarray, xlabel: str
) -> None:
    bins = np.arange(-50, 71, 3)
    centers = (bins[:-1] + bins[1:]) / 2
    means, stds = [], []
    for lo, hi in zip(bins[:-1], bins[1:]):
        vals = values[(points[:, 1] >= lo) & (points[:, 1] < hi)]
        means.append(np.nan if len(vals) < 4 else np.mean(vals))
        stds.append(np.nan if len(vals) < 4 else np.std(vals))
    means, stds = np.asarray(means), np.asarray(stds)
    ax.fill_betweenx(centers, means - stds, means + stds, color="#d7d1cd", lw=0)
    ax.plot(means, centers, color="#6d503d", lw=1.4)
    ax.axvline(0, color="#bdbdbd", lw=1.0, ls="--")
    ax.set_ylim(-55, 75)
    ax.set_xlim(-1.5, 1.5)
    ax.set_xticks([-1.5, 0, 1.5])
    ax.set_yticks([-30, 0, 30, 60])
    ax.tick_params(axis="y", labelleft=False, left=True, right=True, length=4)
    ax.tick_params(axis="x", labelsize=8)
    ax.set_xlabel(xlabel, fontsize=9)
    panel_label(ax, "b")


def draw_distribution(
    ax: plt.Axes,
    values: np.ndarray,
    title: str,
    label: str,
    expected_mean: float,
    ylim: tuple[float, float],
) -> None:
    bins = np.linspace(-3, 3, 34)
    counts, edges = np.histogram(values, bins=bins, density=True)
    centers = (edges[:-1] + edges[1:]) / 2
    norm = TwoSlopeNorm(vmin=-3, vcenter=0, vmax=3)
    colors = mpl.colormaps["RdBu_r"](norm(centers))
    ax.bar(centers, counts, width=np.diff(edges) * 0.88, color=colors, edgecolor="white", lw=0.25)
    grid = np.linspace(-3, 3, 400)
    kde = gaussian_kde(values, bw_method=0.32)
    density = kde(grid)
    ax.plot(grid, density, color="#575757", lw=1.4)
    ax.axvline(expected_mean, color="black", lw=1.0, ls="--")
    ax.text(
        expected_mean + 0.10,
        ylim[1] * 0.89,
        f"Mean:\n{expected_mean:.2f} °C",
        fontsize=9,
        ha="left",
        va="top",
    )
    ax.set_xlim(-3, 3)
    ax.set_ylim(*ylim)
    ax.set_xticks([-3, -1.5, 0, 1.5, 3])
    ax.set_xlabel("ΔS(°C)", fontsize=10)
    if label == "c":
        ax.set_ylabel("Probability density", fontsize=10)
    ax.set_title(f"{label} {title}", loc="left", fontsize=11, fontweight="bold", pad=2)
    ax.tick_params(labelsize=8, direction="in", length=4)


def make_figure(output_stem: Path = OUTPUT) -> None:
    """Reproduce the global analytical map with zonal and KDE evidence panels."""
    configure_matplotlib()
    rings = load_world_rings()
    points, values, sizes, _ = simulate_forest_grid(rings)
    fig = plt.figure(figsize=(11.7, 7.85), facecolor="white")
    outer = fig.add_gridspec(
        2,
        1,
        left=0.06,
        right=0.985,
        top=0.985,
        bottom=0.075,
        height_ratios=[1.04, 0.96],
        hspace=0.22,
    )
    top = outer[0].subgridspec(1, 4, width_ratios=[1, 1, 1, 0.54], wspace=0.0)
    bottom = outer[1].subgridspec(1, 3, wspace=0.21)
    ax_map = fig.add_subplot(top[0, :3])
    ax_zonal = fig.add_subplot(top[0, 3], sharey=ax_map)
    draw_map(fig, ax_map, rings, points, values, sizes)
    draw_zonal(ax_zonal, points, values, "Zonal mean ± std")

    tropical = values[np.abs(points[:, 1]) <= 23]
    temperate = values[(np.abs(points[:, 1]) > 23) & (points[:, 1] < 50)]
    boreal = values[points[:, 1] >= 50]
    draw_distribution(fig.add_subplot(bottom[0, 0]), tropical, "Tropical", "c", 0.54, (0, 0.8))
    draw_distribution(fig.add_subplot(bottom[0, 1]), temperate, "Temperate", "d", 0.39, (0, 1.0))
    draw_distribution(fig.add_subplot(bottom[0, 2]), boreal, "Boreal", "e", -0.03, (0, 1.5))

    output_stem.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(output_stem.with_suffix(".png"), dpi=300, facecolor="white")
    fig.savefig(output_stem.with_suffix(".pdf"), facecolor="white")
    fig.savefig(output_stem.with_suffix(".svg"), facecolor="white")
    plt.close(fig)


def main() -> None:
    make_figure()


if __name__ == "__main__":
    main()
