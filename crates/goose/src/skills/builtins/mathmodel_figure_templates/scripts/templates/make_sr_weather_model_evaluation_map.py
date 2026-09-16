from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("MPLCONFIGDIR", str(ROOT / ".mplconfig"))

import matplotlib as mpl

mpl.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from scipy.ndimage import distance_transform_edt, gaussian_filter

import cartopy

cartopy.config["data_dir"] = str(ROOT / ".cartopy")
import cartopy.crs as ccrs
from cartopy.io import shapereader
from cartopy.mpl.ticker import LatitudeFormatter, LongitudeFormatter
from shapely import contains_xy
from shapely.ops import unary_union


MODELS = ["Bicubic", "HAT", "SRGAN", "SE-SRCNN", "SR-Weather"]
RMSE = np.array([1.7903, 1.4720, 1.3254, 1.2398, 1.1593])
R2 = np.array([0.6468, 0.7701, 0.8119, 0.8291, 0.8501])
AMBE = np.array([1.3523, 0.3204, 0.3756, 0.4339, 0.3380])
EXTENT = (126.0, 130.0, 33.0, 39.0)
DATA_PATH = ROOT / "data" / "korea_srtm_dem.npz"


def configure_matplotlib() -> None:
    mpl.rcParams.update(
        {
            "font.family": "sans-serif",
            "font.sans-serif": ["Arial", "Helvetica", "DejaVu Sans", "sans-serif"],
            "font.size": 7,
            "svg.fonttype": "none",
            "pdf.fonttype": 42,
            "axes.linewidth": 0.65,
            "xtick.major.width": 0.55,
            "ytick.major.width": 0.55,
        }
    )


@lru_cache(maxsize=1)
def korea_geometry():
    shp = shapereader.natural_earth(
        resolution="10m", category="cultural", name="admin_0_countries"
    )
    geoms = [
        rec.geometry
        for rec in shapereader.Reader(shp).records()
        if rec.attributes.get("ADM0_A3") == "KOR"
    ]
    if not geoms:
        raise RuntimeError("Natural Earth South Korea geometry was not found")
    return unary_union(geoms)


def fill_inside_nans(values: np.ndarray, inside: np.ndarray) -> np.ndarray:
    out = values.astype(float, copy=True)
    missing = inside & ~np.isfinite(out)
    if missing.any():
        _, indices = distance_transform_edt(~np.isfinite(out), return_indices=True)
        out[missing] = out[tuple(indices[:, missing])]
    out[~inside] = np.nan
    return out


def load_geography() -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    if not DATA_PATH.exists():
        raise FileNotFoundError(
            f"Missing {DATA_PATH}. Build the cached SRTM grid before rendering."
        )
    data = np.load(DATA_PATH)
    x = data["x"]
    y = data["y"]
    dem = data["dem"].astype(float)
    xx, yy = np.meshgrid(x, y)
    geom = korea_geometry()
    inside = contains_xy(geom, xx, yy)
    dem = fill_inside_nans(dem, inside)
    dem = np.where(inside, np.clip(dem, 0, 1600), np.nan)
    return x, y, xx, yy, inside, dem


def gaussian(xx: np.ndarray, yy: np.ndarray, lon: float, lat: float, sx: float, sy: float) -> np.ndarray:
    return np.exp(-0.5 * (((xx - lon) / sx) ** 2 + ((yy - lat) / sy) ** 2))


def impervious_surface(xx: np.ndarray, yy: np.ndarray, inside: np.ndarray) -> np.ndarray:
    cities = [
        (126.9780, 37.5665, 100, 0.16),  # Seoul
        (126.7052, 37.4563, 84, 0.13),   # Incheon
        (127.0286, 37.2636, 70, 0.11),   # Suwon
        (127.3845, 36.3504, 48, 0.10),   # Daejeon
        (127.4890, 36.6424, 35, 0.09),   # Cheongju
        (128.6014, 35.8714, 60, 0.11),   # Daegu
        (129.0756, 35.1796, 75, 0.13),   # Busan
        (129.3114, 35.5384, 50, 0.10),   # Ulsan
        (128.6811, 35.2279, 45, 0.10),   # Changwon
        (126.8526, 35.1595, 46, 0.10),   # Gwangju
        (127.1480, 35.8242, 34, 0.09),   # Jeonju
        (126.5312, 33.4996, 28, 0.08),   # Jeju City
    ]
    imp = np.zeros_like(xx)
    for lon, lat, level, size in cities:
        imp = np.maximum(imp, level * gaussian(xx, yy, lon, lat, size, size * 0.8))

    # Small secondary settlements produce the sparse red speckle visible in the source.
    rng = np.random.default_rng(132805)
    points = rng.choice(np.flatnonzero(inside), size=360, replace=False)
    settlement = np.zeros_like(xx)
    settlement.flat[points] = rng.uniform(8, 34, len(points))
    settlement = gaussian_filter(settlement, sigma=0.75)
    imp = np.maximum(imp, settlement * 2.7)
    return np.where(inside, np.clip(imp, 0, 100), np.nan)


def normalize_inside(values: np.ndarray, inside: np.ndarray) -> np.ndarray:
    lo, hi = np.nanpercentile(values[inside], [1, 99])
    return np.clip((values - lo) / max(hi - lo, 1e-9), 0, 1)


def force_mean(values: np.ndarray, inside: np.ndarray, target: float) -> np.ndarray:
    return values * (target / np.nanmean(values[inside]))


def force_abs_mean(values: np.ndarray, inside: np.ndarray, target: float) -> np.ndarray:
    return values * (target / np.nanmean(np.abs(values[inside])))


def simulate_maps() -> tuple[list[list[np.ndarray]], np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    x, y, xx, yy, inside, dem = load_geography()
    rng = np.random.default_rng(1328)
    dem_n = normalize_inside(dem, inside)
    imp = impervious_surface(xx, yy, inside)
    imp_n = np.nan_to_num(imp / 100.0)

    fine = gaussian_filter(rng.normal(size=xx.shape), sigma=0.7)
    mid = gaussian_filter(rng.normal(size=xx.shape), sigma=2.0)
    broad = gaussian_filter(rng.normal(size=xx.shape), sigma=7.0)
    fine = normalize_inside(fine, inside) - 0.5
    mid = normalize_inside(mid, inside) - 0.5
    broad = normalize_inside(broad, inside) - 0.5

    # HAT's visible patch seams are reproduced explicitly from spatial tiles.
    tile = np.zeros_like(xx)
    tile += np.where(xx < 127.45, 0.12, -0.03)
    tile += np.where(yy < 36.05, -0.13, 0.08)
    tile += np.where((xx > 128.35) & (yy > 36.0), 0.11, 0.0)

    rmse_fields: list[np.ndarray] = []
    r2_fields: list[np.ndarray] = []
    mbe_fields: list[np.ndarray] = []
    for idx in range(5):
        texture_amp = [0.48, 0.29, 0.22, 0.18, 0.15][idx]
        topo_amp = [0.55, 0.28, 0.22, 0.17, 0.12][idx]
        base = 0.62 + topo_amp * dem_n + 0.35 * imp_n + texture_amp * (fine + 0.55 * mid)
        if idx == 1:
            base += tile
        rmse = force_mean(np.clip(base, 0.05, None), inside, RMSE[idx])

        corr = 0.46 + 0.34 * (1 - dem_n) - 0.16 * imp_n - 0.20 * texture_amp * fine
        if idx == 1:
            corr -= 0.10 * tile
        corr += R2[idx] - np.nanmean(corr[inside])

        if idx == 0:
            bias = 1.05 + 0.95 * mid + 0.38 * broad - 0.75 * dem_n + 0.75 * imp_n
        elif idx == 1:
            bias = 0.26 * fine + 0.20 * mid + 1.8 * tile - 0.08
        else:
            bias = (
                (0.32 - idx * 0.035) * fine
                + (0.22 - idx * 0.025) * mid
                + 0.18 * broad
                + 0.18 * imp_n
                - 0.12 * dem_n
                + 0.12
            )
        bias = force_abs_mean(bias, inside, AMBE[idx])

        rmse_fields.append(np.where(inside, np.clip(rmse, 0, 3), np.nan))
        r2_fields.append(np.where(inside, np.clip(corr, 0, 1), np.nan))
        mbe_fields.append(np.where(inside, np.clip(bias, -3, 3), np.nan))

    return [rmse_fields, r2_fields, mbe_fields], dem, imp, xx, yy


def map_axis(fig: plt.Figure, bounds: list[float]) -> plt.Axes:
    ax = fig.add_axes(bounds, projection=ccrs.PlateCarree())
    ax.set_extent(EXTENT, crs=ccrs.PlateCarree())
    ax.set_facecolor("#f6f2ee")
    ax.set_xticks([126, 128, 130], crs=ccrs.PlateCarree())
    ax.set_yticks([33.0, 34.2, 35.4, 36.6, 37.8, 39.0], crs=ccrs.PlateCarree())
    ax.xaxis.set_major_formatter(LongitudeFormatter(number_format=".0f", degree_symbol="°"))
    ax.yaxis.set_major_formatter(LatitudeFormatter(number_format=".1f", degree_symbol="°"))
    ax.tick_params(labelsize=5.2, length=2.0, pad=0.8)
    for spine in ax.spines.values():
        spine.set_color("#59636a")
        spine.set_linewidth(0.62)
    return ax


def add_outline(ax: plt.Axes, linewidth: float = 0.42) -> None:
    ax.add_geometries(
        [korea_geometry()],
        crs=ccrs.PlateCarree(),
        facecolor="none",
        edgecolor="#39464e",
        linewidth=linewidth,
        zorder=5,
    )


def make_figure(output_stem: Path) -> None:
    configure_matplotlib()
    rows, dem, imp, xx, yy = simulate_maps()
    fig = plt.figure(figsize=(14.55, 10.0), facecolor="white")

    left = 0.025
    panel_w = 0.128
    gap_x = 0.014
    row_h = 0.255
    row_y = [0.675, 0.365, 0.055]
    cbar_x = 0.742
    cbar_w = 0.011

    cmaps = ["YlOrRd", "YlGnBu", "bwr"]
    limits = [(0, 3), (0, 1), (-3, 3)]
    values = [RMSE, R2, AMBE]
    labels = ["RMSE", "R²", "A-MBE"]
    units = ["K", "", "K"]
    ticks = [[0, 1, 2, 3], [0, 0.2, 0.4, 0.6, 0.8, 1.0], [-3, -2, -1, 0, 1, 2, 3]]

    for row in range(3):
        image = None
        for col, model in enumerate(MODELS):
            x0 = left + col * (panel_w + gap_x)
            ax = map_axis(fig, [x0, row_y[row], panel_w, row_h])
            image = ax.pcolormesh(
                xx,
                yy,
                rows[row][col],
                transform=ccrs.PlateCarree(),
                shading="auto",
                cmap=cmaps[row],
                vmin=limits[row][0],
                vmax=limits[row][1],
                rasterized=True,
            )
            add_outline(ax)
            if row == 0:
                ax.set_title(model, fontsize=11.2, pad=5, weight="normal")
            ax.text(
                0.97,
                0.035,
                f"{labels[row]}: {values[row][col]:.4f}{units[row]}",
                transform=ax.transAxes,
                ha="right",
                va="bottom",
                fontsize=6.9,
                color="#1f262a",
                zorder=8,
                bbox={"facecolor": "white", "edgecolor": "none", "alpha": 0.72, "pad": 1.2},
            )
        cax = fig.add_axes([cbar_x, row_y[row], cbar_w, row_h])
        cb = fig.colorbar(image, cax=cax, ticks=ticks[row])
        cb.ax.tick_params(labelsize=7.0, length=2.2, width=0.5, pad=1.8)
        cb.outline.set_linewidth(0.6)

    # Right-side auxiliary predictors.
    side_x, side_w = 0.805, 0.126
    side_h = 0.345
    side_y = [0.535, 0.095]
    side_fields = [dem, imp]
    side_titles = [r"DEM ($m$)", "Impervious ratio (%)"]
    side_limits = [(0, 1600), (0, 100)]
    side_ticks = [np.arange(0, 1601, 200), np.arange(0, 101, 20)]
    for idx in range(2):
        ax = map_axis(fig, [side_x, side_y[idx], side_w, side_h])
        image = ax.pcolormesh(
            xx,
            yy,
            side_fields[idx],
            transform=ccrs.PlateCarree(),
            shading="auto",
            cmap="Reds",
            vmin=side_limits[idx][0],
            vmax=side_limits[idx][1],
            rasterized=True,
        )
        add_outline(ax, linewidth=0.50)
        ax.set_title(side_titles[idx], fontsize=11.0, pad=5)
        cax = fig.add_axes([0.948, side_y[idx], 0.0105, side_h])
        cb = fig.colorbar(image, cax=cax, ticks=side_ticks[idx])
        cb.ax.tick_params(labelsize=6.7, length=2.0, width=0.5, pad=1.8)
        cb.outline.set_linewidth(0.6)

    fig.text(0.003, 0.977, "(a)", fontsize=17, ha="left", va="top")
    fig.text(0.775, 0.900, "(b)", fontsize=17, ha="left", va="top")

    output_stem.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(output_stem.with_suffix(".svg"), facecolor="white")
    fig.savefig(output_stem.with_suffix(".pdf"), facecolor="white")
    fig.savefig(output_stem.with_suffix(".png"), dpi=300, facecolor="white")
    fig.savefig(output_stem.with_suffix(".tiff"), dpi=600, facecolor="white")
    plt.close(fig)


def main() -> None:
    make_figure(ROOT / "outputs" / "sr_weather_model_evaluation_map_replica")


if __name__ == "__main__":
    main()
