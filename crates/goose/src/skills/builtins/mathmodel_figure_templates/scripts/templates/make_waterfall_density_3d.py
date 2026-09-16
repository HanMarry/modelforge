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


from mpl_toolkits.mplot3d.art3d import Poly3DCollection


from matplotlib.colors import LinearSegmentedColormap, ListedColormap, BoundaryNorm
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
    from mpl_toolkits.mplot3d.art3d import Poly3DCollection

    fig = plt.figure(figsize=(7, 5.7))
    ax = fig.add_subplot(111, projection="3d")
    x = np.linspace(800, 1700, 180)
    palette = ["#674063", "#4f9b98", "#a6d6a1", "#e4d941"]
    for g, c in enumerate(palette):
        for stage in range(3):
            depth = (3 - g) * 2 + stage * 0.48
            center = 1420 - 88 * g + stage * 8
            width = 39 + g * 6
            peak = (2400 - 350 * g) * (1 - 0.24 * stage)
            z = peak * np.exp(-0.5 * ((x - center) / width) ** 2)
            verts = (
                [(x[0], depth, 0)]
                + list(zip(x, np.full(len(x), depth), z))
                + [(x[-1], depth, 0)]
            )
            ax.add_collection3d(
                Poly3DCollection(
                    [verts], facecolors=c, edgecolors=c, linewidths=0.6, alpha=0.30
                )
            )
            ax.plot(x, np.full(len(x), depth), z, c=c, lw=0.85)
            ax.text(820, depth, 100, f"A{stage + 1}", fontsize=5, color=".4")
    ax.set(
        xlim=(800, 1700),
        ylim=(-0.2, 7.4),
        zlim=(0, 2600),
        xlabel="Wavelength (nm)",
        zlabel="Amplitude (a.u.)",
    )
    ax.set_yticks([])
    ax.view_init(22, -66)
    ax.set_box_aspect((1.35, 1.15, 0.95))
    ax.grid(False)
    for a in [ax.xaxis, ax.yaxis, ax.zaxis]:
        a.pane.fill = False
    ax.legend(
        handles=[
            Rectangle((0, 0), 1, 1, fc=c, label=f"Group {chr(65 + i)}")
            for i, c in enumerate(palette)
        ],
        loc="upper right",
        fontsize=7,
    )
    export(fig, output_stem)


if __name__ == "__main__":
    make_figure(ROOT / "outputs" / "waterfall_density_3d_replica")
