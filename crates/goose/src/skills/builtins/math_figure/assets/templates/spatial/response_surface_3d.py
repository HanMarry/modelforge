"""Response surface as a 3D surface with a contour floor (响应面 3D 曲面).

Plots the objective over two decision variables, projects the contours onto the floor
so the shape is readable from above as well as in perspective, and marks the optimum.

Run directly::

    uv run --with matplotlib python response_surface_3d.py -o out/response.pdf
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np  # noqa: E402

from _style import (  # noqa: E402
    PALETTE,
    enable_utf8_stdout,
    apply_style,
    draw_note,
    resolve_cjk_font,
    save_figure,
)

ZH_AXES = ("决策变量 x1", "决策变量 x2", "目标函数 f")
EN_AXES = ("Decision variable x1", "Decision variable x2", "Objective f")


def objective(x: np.ndarray, y: np.ndarray) -> np.ndarray:
    """A bowl with an offset minimum, so the optimum is not at the grid centre."""
    return 0.9 * (x - 0.35) ** 2 + 1.6 * (y + 0.25) ** 2 + 0.35 * (x - 0.35) * (y + 0.25)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("-o", "--output", default="out/response.pdf")
    parser.add_argument("--resolution", type=int, default=120)
    parser.add_argument("--lang", choices=["auto", "zh", "en"], default="auto")
    args = parser.parse_args()
    enable_utf8_stdout()

    try:
        import matplotlib.pyplot as plt
        from matplotlib.colors import LinearSegmentedColormap
    except ImportError as exc:
        print(f"matplotlib is required: {exc}", file=sys.stderr)
        return 2

    use_zh = args.lang == "zh" or (args.lang == "auto" and resolve_cjk_font() is not None)
    axes_labels = ZH_AXES if use_zh else EN_AXES
    text = (
        {
            "title": "响应面与等高线投影",
            "optimum": "最优解",
            "note": "演示数据（合成）：目标函数为示例函数，替换为你的模型输出",
        }
        if use_zh
        else {
            "title": "Response surface with contour projection",
            "optimum": "Optimum",
            "note": "Demo data (synthetic): replace with your model output",
        }
    )

    apply_style()

    span = np.linspace(-1.0, 1.0, args.resolution)
    xx, yy = np.meshgrid(span, span)
    zz = objective(xx, yy)

    cmap = LinearSegmentedColormap.from_list(
        "modelforge_surface", [PALETTE["highlight"], "#E9EDF0", PALETTE["accent"]]
    )

    fig = plt.figure(figsize=(6.4, 5.2))
    ax = fig.add_subplot(111, projection="3d")

    surface = ax.plot_surface(
        xx,
        yy,
        zz,
        cmap=cmap,
        linewidth=0,
        antialiased=True,
        rstride=2,
        cstride=2,
        alpha=0.95,
    )

    # Contours projected onto the floor of the box, which is what makes the
    # perspective view quantitative rather than decorative.
    floor = zz.min() - 0.06 * (zz.max() - zz.min())
    ax.contour(
        xx,
        yy,
        zz,
        zdir="z",
        offset=floor,
        levels=12,
        cmap=cmap,
        linewidths=0.7,
    )

    optimum_index = np.unravel_index(np.argmin(zz), zz.shape)
    ax.scatter(
        [xx[optimum_index]],
        [yy[optimum_index]],
        [zz[optimum_index]],
        color=PALETTE["primary"],
        s=28,
        depthshade=False,
        zorder=10,
    )
    ax.text(
        xx[optimum_index],
        yy[optimum_index],
        zz[optimum_index],
        f"  {text['optimum']} ({xx[optimum_index]:.2f}, {yy[optimum_index]:.2f})",
        fontsize=7,
        color=PALETTE["primary"],
    )

    ax.set_xlabel(axes_labels[0], fontsize=8, labelpad=6)
    ax.set_ylabel(axes_labels[1], fontsize=8, labelpad=6)
    ax.set_zlabel(axes_labels[2], fontsize=8, labelpad=4)
    ax.set_zlim(floor, zz.max())
    ax.tick_params(labelsize=7)
    ax.view_init(elev=26, azim=-58)
    ax.set_title(text["title"], fontsize=11, color=PALETTE["primary"], pad=2)

    bar = fig.colorbar(surface, ax=ax, fraction=0.028, pad=0.08, shrink=0.72)
    bar.set_label(axes_labels[2], fontsize=8)
    bar.ax.tick_params(labelsize=7)

    fig.tight_layout()
    draw_note(fig, text["note"], y=-0.02)

    written = save_figure(fig, args.output)
    plt.close(fig)
    for path in written:
        print(f"wrote {path}")
    print(
        f"optimum at ({xx[optimum_index]:.3f}, {yy[optimum_index]:.3f}) "
        f"f = {zz[optimum_index]:.4f}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
