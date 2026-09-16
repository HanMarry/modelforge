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
from matplotlib.patches import Patch, Polygon
from matplotlib.path import Path as MplPath


WORLD = ROOT / "data" / "natural_earth_world_simplified.geojson"
OUTPUT = (
    ROOT / "outputs" / "10-1038-s43247-025-03048-9" / "figure-2" / "biodiversity_global_correlation_atlas_replica"
    if (ROOT / "sources" / "10-1038-s43247-025-03048-9").exists()
    else ROOT / "outputs" / "biodiversity_global_correlation_atlas_replica"
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
        polygons = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
        for polygon in polygons:
            if polygon:
                ring = np.asarray(polygon[0], dtype=float)
                if len(ring) >= 4:
                    rings.append(ring)
    return rings


def land_mask(points: np.ndarray, rings: list[np.ndarray]) -> np.ndarray:
    mask = np.zeros(len(points), dtype=bool)
    for ring in rings:
        mask |= MplPath(ring).contains_points(points)
    return mask


def draw_world(ax: plt.Axes, rings: list[np.ndarray], face: str = "#f7f7f7") -> None:
    ax.add_collection(
        PatchCollection(
            [Polygon(r, closed=True) for r in rings],
            facecolor=face,
            edgecolor="#262626",
            linewidth=0.42,
            zorder=1,
        )
    )


def simulate_correlation_grid(
    rings: list[np.ndarray], seed: int = 4202
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    rng = np.random.default_rng(seed)
    lons = np.arange(-176, 177, 1.75)
    lats = np.arange(-52, 70, 1.75)
    lon2, lat2 = np.meshgrid(lons, lats)
    pts = np.column_stack([lon2.ravel(), lat2.ravel()])
    is_land = land_mask(pts, rings)
    lon, lat = pts[:, 0], pts[:, 1]
    score = np.zeros(len(pts))
    for x0, y0, sx, sy, amp in [
        (-64, -5, 28, 18, 1.25),
        (23, 1, 23, 17, 1.1),
        (105, 12, 29, 20, 1.2),
        (-82, 39, 30, 16, 0.9),
        (18, 50, 38, 13, 0.78),
        (105, 52, 52, 14, 0.86),
        (-116, 55, 38, 13, 0.75),
    ]:
        score += amp * np.exp(-((lon - x0) / sx) ** 2 - ((lat - y0) / sy) ** 2)
    score += rng.normal(0, 0.14, len(score))
    forest = is_land & (score > 0.46) & (lat > -48)
    corr = (
        0.18
        + 0.22 * np.cos(np.deg2rad(lat * 1.8))
        + 0.18 * np.sin(np.deg2rad(lon * 2.2))
        - 0.11 * np.cos(np.deg2rad(lon + lat * 4))
        + rng.normal(0, 0.18, len(score))
    )
    corr = np.clip(corr, -0.92, 0.94)
    strength = np.abs(corr) + rng.uniform(0, 0.28, len(corr))
    sizes = np.select([strength > 0.80, strength > 0.58, strength > 0.36], [10.5, 7, 4.3], default=2.2)
    return pts[forest], corr[forest], sizes[forest]


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
    corr: np.ndarray,
    sizes: np.ndarray,
) -> None:
    draw_world(ax, rings)
    zone_gray = np.where(
        points[:, 1] >= 50,
        "#b7b7b7",
        np.where(np.abs(points[:, 1]) <= 23, "#e4e4e4", "#cdcdcd"),
    )
    ax.scatter(points[:, 0], points[:, 1], s=11, c=zone_gray, marker="s", lw=0, zorder=2)
    norm = TwoSlopeNorm(vmin=-1, vcenter=0, vmax=1)
    sc = ax.scatter(
        points[:, 0],
        points[:, 1],
        c=corr,
        s=sizes,
        cmap="RdBu_r",
        norm=norm,
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
    cb.set_ticks([-1, -0.5, 0, 0.5, 1])
    cb.ax.tick_params(labelsize=7, length=3)
    cb.outline.set_linewidth(0.8)
    ax.text(0.063, 0.42, r"$R$(Bio, ΔS)", transform=ax.transAxes, fontsize=8, ha="left")
    ax.text(0.53, 0.105, r"$P$", transform=ax.transAxes, fontsize=8, fontstyle="italic")
    for x, s, label in zip(
        [0.585, 0.685, 0.775, 0.865], [10.5, 7.0, 4.3, 2.2], ["<0.001", "0.01", "0.05", ">0.05"]
    ):
        ax.scatter([x], [0.105], transform=ax.transAxes, s=s, c="black", clip_on=False)
        ax.text(x + 0.018, 0.105, label, transform=ax.transAxes, fontsize=7, va="center")


def draw_zonal(ax: plt.Axes, points: np.ndarray, corr: np.ndarray) -> None:
    bins = np.arange(-50, 71, 3)
    centers = (bins[:-1] + bins[1:]) / 2
    means, stds = [], []
    for lo, hi in zip(bins[:-1], bins[1:]):
        vals = corr[(points[:, 1] >= lo) & (points[:, 1] < hi)]
        means.append(np.nan if len(vals) < 4 else np.mean(vals))
        stds.append(np.nan if len(vals) < 4 else np.std(vals))
    means, stds = np.asarray(means), np.asarray(stds)
    ax.fill_betweenx(centers, means - stds, means + stds, color="#ddd7db", lw=0)
    ax.plot(means, centers, color="#765263", lw=1.4)
    ax.axvline(0, color="#bdbdbd", lw=1.0, ls="--")
    ax.set_xlim(-0.5, 0.5)
    ax.set_ylim(-55, 75)
    ax.set_xticks([-0.5, 0, 0.5])
    ax.set_yticks([-30, 0, 30, 60])
    ax.tick_params(axis="y", labelleft=False, left=True, right=True, length=4)
    ax.tick_params(axis="x", labelsize=8)
    ax.set_xlabel("Zonal mean ± std", fontsize=9)
    panel_label(ax, "b")


FEATURES = {
    "Tropical": ["Bio", "AGB", "Radiation", "Temp", "N", "TreeHeight", "SM", "TreeCover", "DEM", "TreeAge", "Pre", "Clay", "LAI", "SOC", "VPD"],
    "Temperate": ["Bio", "TreeHeight", "AGB", "TreeAge", "Radiation", "SM", "DEM", "Temp", "N", "LAI", "VPD", "TreeCover", "Pre", "Clay", "SOC"],
    "Boreal": ["Bio", "N", "Radiation", "AGB", "Pre", "LAI", "SOC", "Temp", "DEM", "VPD", "TreeAge", "TreeCover", "SM", "TreeHeight", "Clay"],
}


def coefficient_values(zone: str) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    if zone == "Tropical":
        partial = np.array([0.125, 0.102, -0.087, -0.084, -0.071, -0.059, -0.061, 0.051, -0.047, -0.043, 0.040, -0.032, 0.026, -0.012, -0.004])
        regression = np.array([0.185, 0.168, -0.112, -0.178, -0.096, -0.098, -0.060, 0.079, -0.092, -0.051, 0.049, -0.041, 0.035, 0.015, -0.009])
    elif zone == "Temperate":
        partial = np.array([0.112, 0.108, -0.098, -0.085, 0.071, 0.052, -0.050, -0.046, 0.040, -0.037, 0.031, 0.025, 0.020, -0.014, 0.010])
        regression = np.array([0.202, 0.164, -0.171, -0.149, 0.140, 0.063, -0.061, -0.155, 0.079, -0.051, 0.065, 0.031, 0.027, -0.023, 0.018])
    else:
        partial = np.array([0.108, 0.103, 0.086, -0.081, 0.070, -0.066, 0.064, -0.061, -0.057, 0.055, -0.040, -0.025, 0.013, 0.008, 0.005])
        regression = np.array([0.141, 0.117, 0.143, -0.132, 0.112, -0.110, 0.086, -0.123, -0.096, 0.087, -0.053, -0.015, 0.010, -0.008, 0.007])
    signs = np.sign(regression)
    return np.abs(partial), np.abs(regression), signs


def draw_coefficients(ax: plt.Axes, zone: str, label: str) -> None:
    features = FEATURES[zone]
    partial, regression, signs = coefficient_values(zone)
    y = np.arange(len(features))
    light = np.where(signs >= 0, "#e2978d", "#a9ccdf")
    dark = np.where(signs >= 0, "#ce5360", "#5b91c5")
    ax.barh(y - 0.18, partial, height=0.34, color=light, edgecolor="none")
    ax.barh(y + 0.18, regression, height=0.34, color=dark, edgecolor="none")
    ax.set_yticks(y)
    ax.set_yticklabels(features, fontsize=8)
    ax.invert_yaxis()
    ax.set_xlim(0, 0.30)
    ax.set_xticks([0, 0.10, 0.20, 0.30])
    ax.set_xlabel("Coefficient", fontsize=10)
    ax.set_title(f"{label} {zone}", loc="left", fontsize=11, fontweight="bold", pad=2)
    ax.tick_params(labelsize=8, direction="in", length=4)
    for yi, (a, b) in enumerate(zip(partial, regression)):
        ax.text(a + 0.006, yi - 0.18, "***" if a > 0.018 else "*", fontsize=6.5, va="center")
        ax.text(b + 0.006, yi + 0.18, "***" if b > 0.018 else "*", fontsize=6.5, va="center")

    handles = [
        Patch(facecolor="#e2978d", label="Partial correlation · positive"),
        Patch(facecolor="#ce5360", label="Multiple regression · positive"),
        Patch(facecolor="#a9ccdf", label="Partial correlation · negative"),
        Patch(facecolor="#5b91c5", label="Multiple regression · negative"),
    ]
    ax.legend(
        handles=handles,
        loc="lower right",
        fontsize=6.3,
        ncol=2,
        frameon=False,
        handlelength=1.8,
        columnspacing=0.8,
        labelspacing=0.35,
    )


def make_figure(output_stem: Path = OUTPUT) -> None:
    """Reproduce the global correlation map and zonal coefficient comparison."""
    configure_matplotlib()
    rings = load_world_rings()
    points, corr, sizes = simulate_correlation_grid(rings)
    fig = plt.figure(figsize=(11.7, 8.1), facecolor="white")
    outer = fig.add_gridspec(
        2,
        1,
        left=0.065,
        right=0.985,
        top=0.985,
        bottom=0.075,
        height_ratios=[0.92, 1.08],
        hspace=0.20,
    )
    top = outer[0].subgridspec(1, 4, width_ratios=[1, 1, 1, 0.54], wspace=0.0)
    bottom = outer[1].subgridspec(1, 3, wspace=0.36)
    ax_map = fig.add_subplot(top[0, :3])
    ax_zonal = fig.add_subplot(top[0, 3], sharey=ax_map)
    draw_map(fig, ax_map, rings, points, corr, sizes)
    draw_zonal(ax_zonal, points, corr)
    draw_coefficients(fig.add_subplot(bottom[0, 0]), "Tropical", "c")
    draw_coefficients(fig.add_subplot(bottom[0, 1]), "Temperate", "d")
    draw_coefficients(fig.add_subplot(bottom[0, 2]), "Boreal", "e")

    output_stem.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(output_stem.with_suffix(".png"), dpi=300, facecolor="white")
    fig.savefig(output_stem.with_suffix(".pdf"), facecolor="white")
    fig.savefig(output_stem.with_suffix(".svg"), facecolor="white")
    plt.close(fig)


def main() -> None:
    make_figure()


if __name__ == "__main__":
    main()
