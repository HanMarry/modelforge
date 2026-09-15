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
from matplotlib.patches import FancyBboxPatch
from scipy.ndimage import distance_transform_edt, gaussian_filter, zoom

import cartopy

cartopy.config["data_dir"] = str(ROOT / ".cartopy")
import cartopy.crs as ccrs
from cartopy.io import shapereader
from cartopy.mpl.ticker import LatitudeFormatter, LongitudeFormatter
from shapely import contains_xy
from shapely.ops import unary_union


MODELS = ["FuXi", "Bicubic", "SRGAN", "SE-SRCNN", "SR-Weather", "MODIS AT"]
DATES = ["2020.04.03", "2020.06.20", "2020.10.22", "2020.11.10"]
MEANS = np.array([280.8, 296.0, 287.0, 284.0])
VMIN = np.array([276.0, 292.0, 276.0, 276.0])
VMAX = np.array([285.0, 300.0, 298.0, 292.0])
EXTENT = (126.0, 130.0, 33.0, 39.0)
SEOUL_EXTENT = (126.52, 127.17, 37.08, 37.83)
DATA_PATH = ROOT / "data" / "korea_srtm_dem.npz"


def configure_matplotlib() -> None:
    mpl.rcParams.update(
        {
            "font.family": "sans-serif",
            "font.sans-serif": ["Arial", "Helvetica", "DejaVu Sans", "sans-serif"],
            "font.size": 7,
            "svg.fonttype": "none",
            "pdf.fonttype": 42,
            "axes.linewidth": 0.62,
            "xtick.major.width": 0.5,
            "ytick.major.width": 0.5,
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
    inside = contains_xy(korea_geometry(), xx, yy)
    dem = fill_inside_nans(dem, inside)
    dem = np.where(inside, np.clip(dem, 0, 1600), np.nan)
    return x, y, xx, yy, inside, dem


def gaussian(xx: np.ndarray, yy: np.ndarray, lon: float, lat: float, sx: float, sy: float) -> np.ndarray:
    return np.exp(-0.5 * (((xx - lon) / sx) ** 2 + ((yy - lat) / sy) ** 2))


def impervious_surface(xx: np.ndarray, yy: np.ndarray, inside: np.ndarray) -> np.ndarray:
    cities = [
        (126.9780, 37.5665, 1.00, 0.16),
        (126.7052, 37.4563, 0.88, 0.13),
        (127.0286, 37.2636, 0.72, 0.11),
        (127.3845, 36.3504, 0.48, 0.10),
        (128.6014, 35.8714, 0.58, 0.11),
        (129.0756, 35.1796, 0.76, 0.13),
        (129.3114, 35.5384, 0.50, 0.10),
        (128.6811, 35.2279, 0.46, 0.10),
        (126.8526, 35.1595, 0.46, 0.10),
        (127.1480, 35.8242, 0.36, 0.09),
    ]
    imp = np.zeros_like(xx)
    for lon, lat, level, size in cities:
        imp = np.maximum(imp, level * gaussian(xx, yy, lon, lat, size, size * 0.8))
    return np.where(inside, np.clip(imp, 0, 1), np.nan)


def coarse_average(field: np.ndarray, shape: tuple[int, int] = (24, 16)) -> np.ndarray:
    yi = np.linspace(0, field.shape[0], shape[0] + 1, dtype=int)
    xi = np.linspace(0, field.shape[1], shape[1] + 1, dtype=int)
    result = np.empty(shape, dtype=float)
    for row in range(shape[0]):
        for col in range(shape[1]):
            block = field[yi[row] : yi[row + 1], xi[col] : xi[col + 1]]
            result[row, col] = np.nanmean(block)
    return result


def resample(coarse: np.ndarray, target_shape: tuple[int, int], order: int) -> np.ndarray:
    factor = (target_shape[0] / coarse.shape[0], target_shape[1] / coarse.shape[1])
    out = zoom(coarse, factor, order=order, mode="nearest")
    return out[: target_shape[0], : target_shape[1]]


def simulate_seasons():
    x, y, xx, yy, inside, dem = load_geography()
    rng = np.random.default_rng(5052026)
    dem_n = np.nan_to_num(dem / 1000.0)
    urban = np.nan_to_num(impervious_surface(xx, yy, inside))
    latitude = yy - np.nanmean(yy[inside])
    coastal_wave = np.sin((xx - 126.0) * 2.35) + 0.45 * np.cos((yy - 33.0) * 2.10)
    output = []
    for idx, mean in enumerate(MEANS):
        synoptic = gaussian_filter(rng.normal(size=xx.shape), sigma=12.0)
        synoptic /= max(np.nanstd(synoptic[inside]), 1e-6)
        fine = gaussian_filter(rng.normal(size=xx.shape), sigma=1.35)
        fine /= max(np.nanstd(fine[inside]), 1e-6)
        lapse = [4.3, 3.4, 6.5, 5.0][idx]
        north_gradient = [-0.22, -0.12, -0.20, -0.23][idx]
        synoptic_amp = [0.55, 0.50, 1.50, 0.90][idx]
        true = (
            mean
            - lapse * dem_n
            + north_gradient * latitude
            + 1.55 * urban
            + 0.58 * coastal_wave
            + synoptic_amp * synoptic
            + 0.22 * fine
        )
        coarse = coarse_average(true)
        nearest = resample(coarse, true.shape, order=0)
        bicubic = resample(coarse, true.shape, order=3)
        srgan = 0.78 * true + 0.22 * bicubic + 0.17 * gaussian_filter(rng.normal(size=xx.shape), 0.9)
        se_srcnn = 0.82 * gaussian_filter(true, 1.0) + 0.18 * bicubic
        sr_weather = 0.94 * true + 0.06 * bicubic + 0.045 * gaussian_filter(rng.normal(size=xx.shape), 1.1)

        # MODIS-like cloud gaps: broad swaths plus granular missing pixels.
        cloud_large = gaussian_filter(rng.random(xx.shape), sigma=12) > [0.512, 0.520, 0.515, 0.523][idx]
        cloud_small = gaussian_filter(rng.random(xx.shape), sigma=1.8) > 0.555
        observed = np.where(cloud_large | cloud_small, np.nan, true)
        output.append(
            {
                "FuXi": nearest,
                "Bicubic": bicubic,
                "SRGAN": np.where(inside, srgan, np.nan),
                "SE-SRCNN": np.where(inside, se_srcnn, np.nan),
                "SR-Weather": np.where(inside, sr_weather, np.nan),
                "MODIS AT": np.where(inside, observed, np.nan),
                "ERA5": nearest,
                "reference": np.where(inside, true, np.nan),
                "reference_full": true,
                "inside": inside,
            }
        )
    return output, x, y, xx, yy


def add_outline(ax: plt.Axes, linewidth: float = 0.40) -> None:
    ax.add_geometries(
        [korea_geometry()],
        crs=ccrs.PlateCarree(),
        facecolor="none",
        edgecolor="#465159",
        linewidth=linewidth,
        zorder=7,
    )


def map_axis(fig: plt.Figure, bounds: list[float], extent=EXTENT, zoomed: bool = False) -> plt.Axes:
    ax = fig.add_axes(bounds, projection=ccrs.PlateCarree())
    ax.set_extent(extent, crs=ccrs.PlateCarree())
    ax.set_facecolor("#f4f2ee")
    if zoomed:
        ax.set_xticks([126.6, 126.9], crs=ccrs.PlateCarree())
        ax.set_yticks([37.2, 37.7], crs=ccrs.PlateCarree())
        ax.xaxis.set_major_formatter(LongitudeFormatter(number_format=".1f", degree_symbol="°"))
        ax.yaxis.set_major_formatter(LatitudeFormatter(number_format=".1f", degree_symbol="°"))
        ax.tick_params(labelsize=4.2, length=1.3, pad=0.5)
    else:
        ax.set_xticks([126, 127, 128, 129, 130], crs=ccrs.PlateCarree())
        ax.set_yticks([33, 34.2, 35.4, 36.6, 37.8, 39], crs=ccrs.PlateCarree())
        ax.xaxis.set_major_formatter(LongitudeFormatter(number_format=".0f", degree_symbol="°"))
        ax.yaxis.set_major_formatter(LatitudeFormatter(number_format=".1f", degree_symbol="°"))
        ax.tick_params(labelsize=4.4, length=1.4, pad=0.5)
    for spine in ax.spines.values():
        spine.set_color("#697278")
        spine.set_linewidth(0.52)
    return ax


def add_group_background(fig: plt.Figure, bounds: tuple[float, float, float, float], color: str) -> None:
    ax = fig.add_axes(bounds, zorder=0)
    ax.axis("off")
    ax.add_patch(
        FancyBboxPatch(
            (0, 0),
            1,
            1,
            transform=ax.transAxes,
            boxstyle="round,pad=0.006,rounding_size=0.055",
            facecolor=color,
            edgecolor="none",
        )
    )


def draw_zoom_panel(
    fig: plt.Figure,
    bounds: list[float],
    xx: np.ndarray,
    yy: np.ndarray,
    data: np.ndarray,
    title: str,
    vmin: float,
    vmax: float,
    coarse: bool = False,
    outline: bool = True,
) -> None:
    ax = map_axis(fig, bounds, extent=SEOUL_EXTENT, zoomed=True)
    ax.pcolormesh(
        xx,
        yy,
        data,
        transform=ccrs.PlateCarree(),
        shading="auto",
        cmap="turbo",
        vmin=vmin,
        vmax=vmax,
        rasterized=True,
    )
    if outline and not coarse:
        add_outline(ax, linewidth=0.34)
    ax.set_title(title, fontsize=6.3, pad=2.0)


def draw_zoom_group(
    fig: plt.Figure,
    base_y: float,
    season: dict[str, np.ndarray],
    xx: np.ndarray,
    yy: np.ndarray,
    date: str,
    season_index: int,
) -> None:
    gx = 0.700
    gw = 0.285
    gh = 0.425
    add_group_background(fig, (gx, base_y, gw, gh), "#f3f6bb")
    margin_x = 0.018
    gap_x = 0.010
    pw = (gw - 2 * margin_x - 2 * gap_x) / 3
    ph = 0.112
    y_top = base_y + 0.273
    y_mid = base_y + 0.145
    y_bot = base_y + 0.018
    xs = [gx + margin_x + i * (pw + gap_x) for i in range(3)]
    vmin = VMIN[season_index]
    vmax = VMAX[season_index]

    panels = [
        (xs[0], y_top, season["ERA5"], f"ERA5 ({date})", True, False),
        (xs[1], y_top, season["MODIS AT"], "MODIS AT", False, True),
        (xs[0], y_mid, season["FuXi"], "FuXi (1-day)", True, False),
        (xs[1], y_mid, season["SR-Weather"], "SR-Weather (1-day)", False, True),
        (xs[2], y_mid, gaussian_filter(season["reference_full"], 2.0), "LDAPS (1-day)", False, True),
        (xs[0], y_bot, season["FuXi"] - 0.30, "FuXi (5-day)", True, False),
        (xs[1], y_bot, season["SR-Weather"] - 0.16, "SR-Weather (5-day)", False, True),
    ]
    for x0, y0, data, title, coarse, outline in panels:
        draw_zoom_panel(
            fig,
            [x0, y0, pw, ph],
            xx,
            yy,
            data,
            title,
            vmin,
            vmax,
            coarse=coarse,
            outline=outline,
        )

    cax = fig.add_axes([xs[1] + pw + 0.0025, y_top, 0.0040, ph])
    sm = mpl.cm.ScalarMappable(norm=mpl.colors.Normalize(vmin=vmin, vmax=vmax), cmap="turbo")
    cb = fig.colorbar(sm, cax=cax)
    cb.ax.tick_params(labelsize=4.3, length=1.2, width=0.4, pad=1.0)
    cb.outline.set_linewidth(0.45)


def make_figure(output_stem: Path) -> None:
    configure_matplotlib()
    seasons, _, _, xx, yy = simulate_seasons()
    fig = plt.figure(figsize=(15.45, 10.0), facecolor="white")

    left = 0.014
    panel_w = 0.097
    gap_x = 0.0105
    row_h = 0.205
    row_y = [0.755, 0.520, 0.285, 0.050]
    cbar_x = 0.659
    cbar_w = 0.008

    cmap = mpl.colormaps["turbo"].copy()
    cmap.set_bad("white")
    for row, season in enumerate(seasons):
        vmin = VMIN[row]
        vmax = VMAX[row]
        image = None
        for col, model in enumerate(MODELS):
            x0 = left + col * (panel_w + gap_x)
            ax = map_axis(fig, [x0, row_y[row], panel_w, row_h])
            image = ax.pcolormesh(
                xx,
                yy,
                season[model],
                transform=ccrs.PlateCarree(),
                shading="auto",
                cmap=cmap,
                vmin=vmin,
                vmax=vmax,
                rasterized=True,
            )
            if model != "FuXi":
                add_outline(ax, linewidth=0.34)
            if row == 0:
                ax.set_title(f"{model} ($K$)", fontsize=9.3, pad=3.5)
            if col == 5:
                ax.text(
                    0.96,
                    0.035,
                    DATES[row],
                    transform=ax.transAxes,
                    ha="right",
                    va="bottom",
                    fontsize=6.1,
                    color="#20272b",
                    bbox={"facecolor": "white", "edgecolor": "none", "alpha": 0.70, "pad": 1.0},
                    zorder=9,
                )
        cax = fig.add_axes([cbar_x, row_y[row], cbar_w, row_h])
        cb = fig.colorbar(image, cax=cax)
        cb.ax.tick_params(labelsize=5.7, length=1.8, width=0.45, pad=1.2)
        cb.outline.set_linewidth(0.55)

    draw_zoom_group(fig, 0.535, seasons[0], xx, yy, "2020.04.03", 0)
    draw_zoom_group(fig, 0.055, seasons[2], xx, yy, "2020.10.22", 2)

    fig.text(0.003, 0.982, "(a)", fontsize=17, ha="left", va="top")
    fig.text(0.682, 0.972, "(b)", fontsize=17, ha="left", va="top")
    fig.text(0.682, 0.492, "(c)", fontsize=17, ha="left", va="top")

    output_stem.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(output_stem.with_suffix(".svg"), facecolor="white")
    fig.savefig(output_stem.with_suffix(".pdf"), facecolor="white")
    fig.savefig(output_stem.with_suffix(".png"), dpi=300, facecolor="white")
    fig.savefig(output_stem.with_suffix(".tiff"), dpi=600, facecolor="white")
    plt.close(fig)


def main() -> None:
    make_figure(ROOT / "outputs" / "sr_weather_downscaling_map_replica")


if __name__ == "__main__":
    main()
