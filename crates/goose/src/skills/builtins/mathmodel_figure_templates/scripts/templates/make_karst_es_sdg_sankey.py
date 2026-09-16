from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("MPLCONFIGDIR", str(ROOT / ".mplconfig"))

import matplotlib as mpl

mpl.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.path import Path as MplPath
from matplotlib.patches import PathPatch, Rectangle
import numpy as np


SERVICES = [
    ("Habitat quality", 29, "#6E78A8"),
    ("Carbon storage", 19, "#64A6B4"),
    ("Water yield", 25, "#8EC9B6"),
    ("Soil retention", 9, "#D7E7A0"),
]

TARGETS = [
    "1.1", "1.2", "1.5", "2.3", "2.4", "2.5", "3.3", "3.9",
    "6.1", "6.3", "6.4", "6.6", "8.4", "9.4", "11.5", "11.7",
    "11.4", "13.1", "14.1", "14.2", "14.4", "14.7", "14.B",
    "15.1", "15.2", "15.3", "15.4", "15.5", "15.8", "7.1",
    "7.2", "9.1", "11.6", "14.3", "2.1", "2.2", "12.5",
]

GOALS = ["SDG1", "SDG2", "SDG3", "SDG6", "SDG7", "SDG8",
         "SDG9", "SDG11", "SDG12", "SDG13", "SDG14", "SDG15"]


def configure_matplotlib() -> None:
    mpl.rcParams.update({
        "font.family": "sans-serif",
        "font.sans-serif": ["Arial", "Helvetica", "DejaVu Sans", "sans-serif"],
        "font.size": 7.2,
        "svg.fonttype": "none",
        "pdf.fonttype": 42,
        "axes.linewidth": 0.7,
    })


def build_links() -> tuple[list[tuple[int, int]], list[int]]:
    """Deterministic structural reconstruction; not the paper's source table."""
    service_targets: list[tuple[int, int]] = []
    patterns = [
        [0, 1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
         17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28],
        [0, 1, 3, 4, 8, 9, 10, 11, 12, 13, 16, 17, 18, 19, 23, 24,
         25, 26, 29],
        [0, 1, 2, 3, 4, 8, 9, 10, 11, 13, 14, 17, 18, 19, 20, 21,
         22, 23, 24, 25, 26, 27, 29, 30, 31],
        [2, 3, 4, 8, 11, 17, 23, 24, 25],
    ]
    for service_idx, indices in enumerate(patterns):
        service_targets.extend((service_idx, target_idx) for target_idx in indices)
    covered = {target_idx for _, target_idx in service_targets}
    for target_idx in range(len(TARGETS)):
        if target_idx not in covered:
            service_targets.append((target_idx % len(SERVICES), target_idx))

    goal_lookup = {
        "1": 0, "2": 1, "3": 2, "6": 3, "7": 4, "8": 5,
        "9": 6, "11": 7, "12": 8, "13": 9, "14": 10, "15": 11,
    }
    target_goals = [goal_lookup[target.split(".")[0]] for target in TARGETS]
    return service_targets, target_goals


def draw_curve(ax: plt.Axes, p0: tuple[float, float], p1: tuple[float, float],
               color: str, linewidth: float, alpha: float, zorder: int = 1) -> None:
    x0, y0 = p0
    x1, y1 = p1
    dx = x1 - x0
    vertices = [(x0, y0), (x0 + 0.43 * dx, y0),
                (x1 - 0.43 * dx, y1), (x1, y1)]
    path = MplPath(vertices, [MplPath.MOVETO, MplPath.CURVE4,
                              MplPath.CURVE4, MplPath.CURVE4])
    ax.add_patch(PathPatch(path, facecolor="none", edgecolor=color,
                           lw=linewidth, alpha=alpha, capstyle="round",
                           zorder=zorder))


def make_figure(output_stem: Path) -> None:
    configure_matplotlib()
    service_targets, target_goals = build_links()

    fig, ax = plt.subplots(figsize=(12.1, 9.25), facecolor="white")
    ax.set_xlim(0, 1)
    ax.set_ylim(0, 1)
    ax.axis("off")

    left_x, mid_x, right_x = 0.055, 0.51, 0.915
    left_y = np.array([0.895, 0.655, 0.405, 0.135])
    target_y = np.linspace(0.955, 0.075, len(TARGETS))
    goal_y = np.array([0.94, 0.85, 0.75, 0.655, 0.57, 0.49,
                       0.405, 0.32, 0.245, 0.17, 0.095, 0.035])

    goal_colors = ["#E7EFE5", "#D7ECDF", "#E9EDE6", "#E6EAD7",
                   "#F1E8C8", "#E8E7D4", "#D9E7E1", "#D8E7DC",
                   "#EEE9D8", "#E8E5DC", "#CFE7E5", "#CFD8E8"]

    # Draw links first so labels remain crisp.
    per_target_rank: dict[tuple[int, int], int] = {}
    for service_idx, target_idx in service_targets:
        ranks = [s for s, t in service_targets if t == target_idx]
        rank = ranks.index(service_idx)
        per_target_rank[(service_idx, target_idx)] = rank
        y0 = left_y[service_idx] + (rank - 1.2) * 0.0013
        y1 = target_y[target_idx] + (rank - (len(ranks) - 1) / 2) * 0.0018
        draw_curve(ax, (left_x + 0.022, y0), (mid_x - 0.014, y1),
                   SERVICES[service_idx][2], 0.72, 0.34)

    target_palette = ["#7C84AF", "#67A4B0", "#88C5B4", "#D5E79B"]
    for target_idx, goal_idx in enumerate(target_goals):
        incoming = [s for s, t in service_targets if t == target_idx]
        for rank, service_idx in enumerate(incoming):
            offset = (rank - (len(incoming) - 1) / 2) * 0.0016
            draw_curve(ax, (mid_x + 0.012, target_y[target_idx] + offset),
                       (right_x - 0.014, goal_y[goal_idx] + offset * 0.55),
                       target_palette[service_idx], 0.70, 0.30)

    # Left service nodes.
    for (name, count, color), y in zip(SERVICES, left_y):
        height = 0.041 + count * 0.00125
        ax.add_patch(Rectangle((left_x, y - height / 2), 0.022, height,
                               facecolor=color, edgecolor="none", alpha=0.92,
                               zorder=3))
        ax.text(left_x - 0.008, y, f"{count}", ha="right", va="center",
                fontsize=8.4, fontweight="bold")
        ax.text(left_x + 0.028, y, name, ha="left", va="center",
                fontsize=8.8, fontstyle="italic", fontweight="bold",
                color="#263142")

    # Middle target nodes and support counts.
    for idx, (label, y) in enumerate(zip(TARGETS, target_y)):
        count = sum(1 for _, t in service_targets if t == idx)
        mix = np.mean([mpl.colors.to_rgb(SERVICES[s][2])
                       for s, t in service_targets if t == idx], axis=0)
        ax.add_patch(Rectangle((mid_x - 0.012, y - 0.0031), 0.024, 0.0062,
                               facecolor=mix, edgecolor="none", alpha=0.75,
                               zorder=3))
        ax.text(mid_x - 0.018, y, str(count), ha="right", va="center",
                fontsize=6.7, color="#344054")
        ax.text(mid_x + 0.018, y, f"Target {label}", ha="left", va="center",
                fontsize=6.7, color="#263142")

    # Right goal nodes.
    for idx, (goal, y, color) in enumerate(zip(GOALS, goal_y, goal_colors)):
        count = sum(1 for g in target_goals if g == idx)
        ax.add_patch(Rectangle((right_x - 0.014, y - 0.008), 0.052, 0.016,
                               facecolor=color, edgecolor="none", zorder=3))
        ax.text(right_x + 0.012, y, goal, ha="center", va="center",
                fontsize=8.5, fontstyle="italic", fontweight="bold",
                color="#263142")
        ax.text(right_x + 0.047, y, str(count), ha="left", va="center",
                fontsize=7.3, fontweight="bold", color="#344054")

    ax.text(0.055, 0.005, "Types of ecosystem services", ha="left", va="bottom",
            fontsize=10.2, fontweight="bold")
    ax.text(0.51, 0.005, "SDG targets", ha="center", va="bottom",
            fontsize=10.2, fontweight="bold")
    ax.text(0.955, 0.005, "Sustainable development goals", ha="right", va="bottom",
            fontsize=10.2, fontweight="bold")

    output_stem.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(output_stem.with_suffix(".png"), dpi=300, bbox_inches="tight",
                facecolor="white")
    fig.savefig(output_stem.with_suffix(".pdf"), bbox_inches="tight",
                facecolor="white")
    fig.savefig(output_stem.with_suffix(".svg"), bbox_inches="tight",
                facecolor="white")
    fig.savefig(output_stem.with_suffix(".tiff"), dpi=600,
                bbox_inches="tight", facecolor="white", pil_kwargs={"compression": "tiff_lzw"})
    plt.close(fig)


def main() -> None:
    make_figure(ROOT / "outputs" / "karst_es_sdg_sankey_replica")


if __name__ == "__main__":
    main()
