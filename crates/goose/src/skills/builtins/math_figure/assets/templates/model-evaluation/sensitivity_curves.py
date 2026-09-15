"""Sensitivity analysis curves with a tolerance band.

Sweeps each key parameter around its nominal value, plots the resulting change in
the objective, and shades the band within which the conclusion is unchanged. This is
the figure that answers "how much can your inputs move before the answer changes".

Run directly::

    uv run --with matplotlib python sensitivity_curves.py -o out/sensitivity.pdf
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
    SERIES,
    apply_style,
    draw_note,
    resolve_cjk_font,
    save_figure,
)

ZH_PARAMS = ["反应速率 k", "初始浓度 C0", "扩散系数 D", "边界温度 T", "传热系数 h"]
EN_PARAMS = ["Rate k", "Initial C0", "Diffusion D", "Wall temp T", "Heat transfer h"]


def band_bounds(elasticity: float, curvature: float, tolerance: float) -> tuple[float, float]:
    """Ratios at which a response leaves the tolerance band.

    Solves ``e*t + c*t^2 = ±tolerance`` for ``t = ratio - 1`` and keeps the root
    closest to the nominal point on each side, which is the extent of "input may
    move this far without changing the conclusion".
    """
    candidates: list[float] = []
    for target in (tolerance, -tolerance):
        # c*t^2 + e*t - target = 0
        discriminant = elasticity**2 + 4 * curvature * target
        if discriminant < 0:
            continue
        for sign in (1, -1):
            t = (-elasticity + sign * discriminant**0.5) / (2 * curvature)
            if abs(t) < 1e-6:
                continue
            candidates.append(1.0 + t)
    below = [value for value in candidates if value < 1.0]
    above = [value for value in candidates if value > 1.0]
    return (max(below) if below else 0.0, min(above) if above else float("inf"))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("-o", "--output", default="out/sensitivity.pdf")
    parser.add_argument("--seed", type=int, default=20240912)
    parser.add_argument("--tolerance", type=float, default=0.05, help="relative change treated as unchanged")
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
            "x": "参数相对变化",
            "y": "目标函数相对变化",
            "title": "关键参数灵敏度分析",
            "band": "结论不变区间（±5%）",
            "nominal": "基准值",
            "note": "演示数据（合成）：响应为示例函数，替换为你的模型重跑结果",
        }
        if use_zh
        else {
            "x": "Parameter change (relative)",
            "y": "Objective change (relative)",
            "title": "Sensitivity of the objective to key parameters",
            "band": "Unchanged-conclusion band (±5%)",
            "nominal": "Nominal",
            "note": "Demo data (synthetic): replace with your model's re-run results",
        }
    )
    params = ZH_PARAMS if use_zh else EN_PARAMS

    apply_style()

    ratios = np.linspace(0.6, 1.4, 161)
    # Per-parameter elasticity so the curves separate: the ordering is the message.
    elasticity = np.array([0.92, -0.64, 0.41, -0.27, 0.16])
    curvature = np.array([0.22, 0.16, 0.11, 0.07, 0.04])

    fig, ax = plt.subplots(figsize=(6.0, 4.0))

    ax.axhspan(-args.tolerance, args.tolerance, color=PALETTE["tertiary"], alpha=0.28, zorder=0)

    bounds = [
        band_bounds(elasticity[index], curvature[index], args.tolerance)
        for index in range(len(params))
    ]
    # The narrowest window across all parameters bounds how far any input may move.
    safe_low = max(bound[0] for bound in bounds)
    safe_high = min(bound[1] for bound in bounds)
    if safe_low < safe_high:
        ax.axvspan(safe_low, safe_high, color=PALETTE["highlight"], alpha=0.10, zorder=0)
        ax.annotate(
            "",
            xy=(safe_low, -args.tolerance * 4.4),
            xytext=(safe_high, -args.tolerance * 4.4),
            arrowprops={"arrowstyle": "<->", "color": PALETTE["highlight"], "linewidth": 0.9},
        )
        ax.text(
            (safe_low + safe_high) / 2,
            -args.tolerance * 5.1,
            f"{safe_low:.2f} – {safe_high:.2f}",
            color=PALETTE["highlight"],
            fontsize=7,
            ha="center",
            va="top",
        )

    ax.axvline(1.0, color=PALETTE["secondary"], linestyle=":", linewidth=1.0, zorder=1)

    for index, name in enumerate(params):
        response = elasticity[index] * (ratios - 1) + curvature[index] * (ratios - 1) ** 2
        ax.plot(
            ratios,
            response,
            color=SERIES[index % len(SERIES)],
            linewidth=1.5,
            label=f"{name} (弹性 {elasticity[index]:+.2f})"
            if use_zh
            else f"{name} (elasticity {elasticity[index]:+.2f})",
        )

    worst = int(np.argmax(np.abs(elasticity)))

    ax.set_xlabel(text["x"])
    ax.set_ylabel(text["y"])
    ax.set_title(text["title"])
    ax.set_xlim(ratios.min(), ratios.max())
    ax.set_ylim(-args.tolerance * 6, args.tolerance * 6)
    ax.legend(loc="upper left", fontsize=7)
    ax.text(
        0.99,
        0.04,
        text["band"],
        transform=ax.transAxes,
        ha="right",
        fontsize=6.8,
        color=PALETTE["secondary"],
    )

    fig.tight_layout()
    draw_note(fig, text["note"])

    written = save_figure(fig, args.output)
    plt.close(fig)
    for path in written:
        print(f"wrote {path}")
    print(f"most sensitive: {params[worst]} (elasticity {elasticity[worst]:+.2f})")
    if safe_low < safe_high:
        print(
            f"inputs may move within {safe_low:.3f}..{safe_high:.3f} "
            f"before the ±{args.tolerance:.0%} conclusion changes"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
