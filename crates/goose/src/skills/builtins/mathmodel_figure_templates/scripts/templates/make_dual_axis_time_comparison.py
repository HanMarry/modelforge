from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("MPLCONFIGDIR", str(ROOT / ".mplconfig"))
import matplotlib as mpl

mpl.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from scipy import stats
from matplotlib.colors import Normalize
from matplotlib.patches import Circle, Ellipse, Polygon, Wedge

COLORS = ["#287C8E", "#D58B52", "#7774A6", "#668D62", "#C36779", "#A99B59"]


from scipy import stats
from matplotlib.colors import (
    Normalize,
    LinearSegmentedColormap,
    ListedColormap,
    BoundaryNorm,
)
from matplotlib.patches import Rectangle, PathPatch
from matplotlib.path import Path as MplPath
from matplotlib.lines import Line2D
from matplotlib import cm


def configure():
    mpl.rcParams.update(
        {
            "font.family": "DejaVu Serif",
            "font.size": 8,
            "axes.titlesize": 9,
            "axes.labelsize": 8,
            "legend.fontsize": 7,
            "xtick.labelsize": 7,
            "ytick.labelsize": 7,
            "axes.linewidth": 0.65,
            "lines.linewidth": 1.0,
            "xtick.major.width": 0.6,
            "ytick.major.width": 0.6,
            "axes.spines.top": True,
            "axes.spines.right": True,
            "axes.prop_cycle": mpl.cycler(color=COLORS),
            "legend.frameon": False,
            "pdf.fonttype": 42,
            "svg.fonttype": "none",
        }
    )


def export(fig, output_stem):
    output_stem = Path(output_stem)
    output_stem.parent.mkdir(parents=True, exist_ok=True)
    fig.text(
        0.5,
        0.006,
        "Illustrative data",
        ha="center",
        va="bottom",
        fontsize=5,
        color=".55",
    )
    for ext in (".png", ".pdf", ".svg"):
        fig.savefig(
            output_stem.with_suffix(ext),
            dpi=300,
            bbox_inches="tight",
            pad_inches=0.06,
            facecolor="white",
        )
    plt.close(fig)


def make_figure(output_stem):
    configure()
    hours = np.arange(1, 25)
    power = np.array(
        [
            3000,
            2900,
            2950,
            2800,
            2500,
            300,
            -1800,
            -2600,
            -2800,
            -2900,
            -2400,
            -100,
            600,
            650,
            620,
            100,
            -50,
            -1900,
            -2100,
            -1600,
            -1900,
            -300,
            200,
            -100,
        ]
    )
    energy = 8000 + np.cumsum(power)
    fig, ax = plt.subplots(figsize=(8.2, 5.5))
    fig.subplots_adjust(left=0.13, right=0.86, top=0.86, bottom=0.16)
    charge = np.maximum(power, 0)
    discharge = np.minimum(power, 0)
    for j, h in enumerate(hours):
        value = power[j]
        grad = np.linspace(0, 1, 100)[:, None]
        extent = (h - 0.36, h + 0.36, min(0, value), max(0, value))
        cmap = (
            LinearSegmentedColormap.from_list("power", ["#a1bfeb", "#ecc2db"])
            if value > 0
            else LinearSegmentedColormap.from_list("power", ["#ecc2db", "#93d4ce"])
        )
        ax.imshow(
            grad, extent=extent, cmap=cmap, aspect="auto", origin="lower", alpha=0.85
        )
    ax.set(xlim=(0.4, 24.6), ylim=(-3300, 3300), xlabel="Time (h)", ylabel="Power (kW)")
    ax.axhline(0, c=".4", lw=0.6)
    right = ax.twinx()
    right.plot(hours, energy, c="#cf4247", marker="s", ms=3, lw=1.1)
    right.set_ylabel("Stored energy (kWh)")
    right.set_ylim(min(0, energy.min() - 1000), energy.max() * 1.1)
    fig.legend(
        handles=[
            Line2D([], [], c="#cf4247", marker="s", ms=3, label="Stored energy"),
            Rectangle((0, 0), 1, 1, fc="#adc7e9", label="Charging power"),
            Rectangle((0, 0), 1, 1, fc="#b3dcd6", label="Discharging power"),
        ],
        loc="upper center",
        bbox_to_anchor=(0.53, 0.97),
        ncol=2,
        fontsize=7,
    )
    export(fig, output_stem)


if __name__ == "__main__":
    make_figure(ROOT / "outputs" / "dual_axis_time_comparison_replica")
