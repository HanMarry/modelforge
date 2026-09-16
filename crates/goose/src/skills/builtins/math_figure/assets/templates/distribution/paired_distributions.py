"""Distribution comparison: half violin, box plot and jittered points.

Shows group differences with three levels of detail at once — density shape
(half violin), five-number summary (box) and the actual observations (points) —
which is what makes a distribution panel defensible in review.

Run directly::

    uv run --with matplotlib python paired_distributions.py -o out/distributions.pdf
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np  # noqa: E402

from _style import (PALETTE, SERIES, apply_style, draw_note, enable_utf8_stdout, resolve_cjk_font, save_figure)  # noqa: E402

ZH_GROUPS = ["对照组", "低剂量", "中剂量", "高剂量"]
EN_GROUPS = ["Control", "Low", "Mid", "High"]


def kernel_density(values: np.ndarray, grid: np.ndarray, bandwidth: float | None = None) -> np.ndarray:
    """Gaussian KDE with Silverman's rule, so no scipy dependency is needed."""
    values = np.asarray(values, dtype=float)
    n = values.size
    if n < 2:
        return np.zeros_like(grid)
    if bandwidth is None:
        std = values.std(ddof=1)
        iqr = np.subtract(*np.percentile(values, [75, 25]))
        spread = min(std, iqr / 1.349) if iqr > 0 else std
        bandwidth = 0.9 * (spread if spread > 0 else 1.0) * n ** (-1 / 5)
    bandwidth = max(bandwidth, 1e-6)
    diff = (grid[:, None] - values[None, :]) / bandwidth
    density = np.exp(-0.5 * diff**2).sum(axis=1)
    return density / (n * bandwidth * np.sqrt(2 * np.pi))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("-o", "--output", default="out/distributions.pdf")
    parser.add_argument("-n", "--samples", type=int, default=90, help="points per group")
    parser.add_argument("--seed", type=int, default=20240912)
    parser.add_argument("--lang", choices=["auto", "zh", "en"], default="auto")
    args = parser.parse_args()
    enable_utf8_stdout()

    try:
        import matplotlib.pyplot as plt
    except ImportError as exc:
        print(f"matplotlib is required: {exc}", file=sys.stderr)
        return 2

    use_zh = args.lang == "zh" or (args.lang == "auto" and resolve_cjk_font() is not None)
    text = (
        {
            "x": "响应值",
            "title": "分组分布对比：半小提琴 + 箱线 + 散点",
            "note": "演示数据（合成）",
        }
        if use_zh
        else {
            "x": "Response",
            "title": "Group distributions: half violin, box plot and points",
            "note": "Demo data (synthetic)",
        }
    )
    groups = ZH_GROUPS if use_zh else EN_GROUPS

    apply_style()

    rng = np.random.default_rng(args.seed)
    # Increasing mean and variance per group: the panel must separate shape from spread.
    data = [
        rng.normal(loc=1.0 + 0.45 * index, scale=0.35 + 0.06 * index, size=args.samples)
        for index in range(len(groups))
    ]

    fig, ax = plt.subplots(figsize=(5.4, 3.8))
    positions = np.arange(1, len(groups) + 1)
    half = 0.32

    for index, (position, values) in enumerate(zip(positions, data)):
        colour = SERIES[index % len(SERIES)]

        # Half violin on the left of the centre line.
        grid = np.linspace(values.min() - 0.4, values.max() + 0.4, 160)
        density = kernel_density(values, grid)
        density = density / density.max() * half if density.max() > 0 else density
        ax.fill_betweenx(
            grid,
            position - density,
            position,
            facecolor=colour,
            alpha=0.22,
            linewidth=0,
            zorder=1,
        )
        ax.plot(position - density, grid, color=colour, linewidth=1.0, zorder=2)

        # Box plot on the right of the centre line.
        q1, median, q3 = np.percentile(values, [25, 50, 75])
        low, high = values.min(), values.max()
        ax.add_patch(
            plt.Rectangle(
                (position, q1),
                half * 0.55,
                max(q3 - q1, 1e-3),
                facecolor="#FFFFFF",
                edgecolor=colour,
                linewidth=1.1,
                zorder=3,
            )
        )
        ax.plot(
            [position, position + half * 0.55],
            [median, median],
            color=colour,
            linewidth=1.8,
            zorder=4,
        )
        ax.plot(
            [position + half * 0.275, position + half * 0.275],
            [low, high],
            color=colour,
            linewidth=0.9,
            zorder=3,
        )

        # Jittered observations, so n and outliers are visible.
        jitter = rng.uniform(-half * 0.18, half * 0.18, size=values.size)
        ax.scatter(
            np.full(values.size, position + half * 0.28) + jitter,
            values,
            s=6,
            color=colour,
            alpha=0.55,
            linewidths=0,
            zorder=5,
        )

        ax.text(
            position,
            0.02,
            f"n={values.size}",
            transform=ax.get_xaxis_transform(),
            ha="center",
            va="bottom",
            fontsize=6.5,
            color=PALETTE["secondary"],
        )

    ax.set_xticks(positions)
    ax.set_xticklabels(groups)
    ax.set_xlim(0.4, len(groups) + 0.85)
    ax.set_ylabel(text["x"])
    ax.set_title(text["title"])
    ax.grid(axis="x", visible=False)
    fig.tight_layout()
    draw_note(fig, text["note"])
    written = save_figure(fig, args.output)
    plt.close(fig)

    for path in written:
        print(f"wrote {path}")
    for name, values in zip(groups, data):
        print(f"{name}: mean={values.mean():.3f} sd={values.std(ddof=1):.3f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
