"""Feature importance with a per-sample effect beeswarm.

The left panel ranks features by mean absolute effect; the right panel spreads the
individual effects horizontally and colours them by the underlying feature value, so
both "how much does this feature matter" and "in which direction, for which
samples" are readable from one figure.

The beeswarm is drawn directly with matplotlib — no shap dependency, which keeps the
template installable from a bare ``uv run --with matplotlib``.

Run directly::

    uv run --with matplotlib python feature_importance_beeswarm.py -o out/importance.pdf
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np  # noqa: E402

from _style import (PALETTE, apply_style, draw_note, enable_utf8_stdout, resolve_cjk_font, save_figure)  # noqa: E402

ZH_FEATURES = ["初始浓度", "温度", "停留时间", "搅拌速率", "催化剂用量", "pH", "杂质含量", "进料速率"]
EN_FEATURES = [
    "Initial conc.",
    "Temperature",
    "Residence time",
    "Stir rate",
    "Catalyst load",
    "pH",
    "Impurity",
    "Feed rate",
]


def stacked_offsets(values: np.ndarray, spread: float, per_bin: int = 34) -> np.ndarray:
    """Vertical offsets that keep the swarm readable.

    Observations are bucketed along the effect axis; within a bucket they stack
    symmetrically around zero, which is the behaviour that makes a beeswarm
    legible without a physics simulation.
    """
    offsets = np.zeros_like(values, dtype=float)
    if values.size == 0:
        return offsets
    low, high = float(values.min()), float(values.max())
    if high - low < 1e-12:
        return offsets
    bin_index = np.clip(((values - low) / (high - low) * per_bin).astype(int), 0, per_bin)
    for bucket in range(per_bin + 1):
        members = np.flatnonzero(bin_index == bucket)
        if members.size == 0:
            continue
        order = members[np.argsort(values[members])]
        for rank, member in enumerate(order):
            # 0, +1, -1, +2, -2 ... within the bucket.
            step = (rank + 1) // 2
            sign = 1 if rank % 2 else -1
            offsets[member] = sign * step * (spread / max(1, order.size))
    return offsets


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("-o", "--output", default="out/importance.pdf")
    parser.add_argument("-n", "--samples", type=int, default=420)
    parser.add_argument("--seed", type=int, default=20240912)
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
    text = (
        {
            "x": "对预测的影响（效应值）",
            "bar": "平均绝对影响",
            "cbar": "特征取值",
            "low": "低",
            "high": "高",
            "title": "特征重要性与样本效应分布",
            "note": "演示数据（合成）；蜂群图为自实现，无需 shap 依赖",
        }
        if use_zh
        else {
            "x": "Effect on the prediction",
            "bar": "Mean |effect|",
            "cbar": "Feature value",
            "low": "Low",
            "high": "High",
            "title": "Feature importance and per-sample effects",
            "note": "Demo data (synthetic); beeswarm implemented without shap",
        }
    )
    features = ZH_FEATURES if use_zh else EN_FEATURES

    apply_style()

    rng = np.random.default_rng(args.seed)
    count = len(features)
    samples = args.samples

    # Feature values, then effects whose sign follows the value with feature-specific
    # strength, so the colour gradient in the swarm is meaningful.
    values = rng.normal(size=(samples, count))
    strength = np.linspace(0.9, 0.25, count) * rng.choice([-1.0, 1.0], size=count)
    effects = values * strength + rng.normal(scale=0.35, size=(samples, count))

    order = np.argsort(-np.abs(effects).mean(axis=0))
    effects = effects[:, order]
    values = values[:, order]
    ordered_names = [features[index] for index in order]
    importances = np.abs(effects).mean(axis=0)

    cmap = LinearSegmentedColormap.from_list(
        "modelforge_value", [PALETTE["highlight"], "#E9EDF0", PALETTE["accent"]]
    )
    limits = np.percentile(np.abs(effects), 99)

    fig, (ax_bar, ax_swarm) = plt.subplots(
        1,
        2,
        figsize=(7.6, 4.2),
        sharey=True,
        gridspec_kw={"width_ratios": [1.0, 2.1], "wspace": 0.06},
    )

    positions = np.arange(count)
    ax_bar.barh(positions, importances, color=PALETTE["primary"], height=0.55)
    ax_bar.set_xlabel(text["bar"])
    ax_bar.set_yticks(positions)
    ax_bar.set_yticklabels(ordered_names)
    ax_bar.invert_yaxis()
    ax_bar.grid(axis="y", visible=False)

    scatter = None
    for row in range(count):
        row_effects = effects[:, row]
        offsets = stacked_offsets(row_effects, spread=0.42)
        scatter = ax_swarm.scatter(
            row_effects,
            row + offsets,
            c=values[:, row],
            cmap=cmap,
            vmin=-2.5,
            vmax=2.5,
            s=6,
            linewidths=0,
            alpha=0.85,
        )

    ax_swarm.axvline(0, color=PALETTE["secondary"], linewidth=0.8, linestyle="--", zorder=0)
    ax_swarm.set_xlim(-limits, limits)
    ax_swarm.set_xlabel(text["x"])
    ax_swarm.grid(axis="y", visible=False)
    ax_swarm.set_title(text["title"])

    if scatter is not None:
        bar = fig.colorbar(scatter, ax=ax_swarm, fraction=0.03, pad=0.02)
        bar.set_label(text["cbar"], fontsize=8)
        bar.ax.tick_params(labelsize=7)
        bar.set_ticks([-2.5, 0, 2.5])
        bar.set_ticklabels([text["low"], "", text["high"]])

    draw_note(fig, text["note"])

    written = save_figure(fig, args.output)
    plt.close(fig)

    for path in written:
        print(f"wrote {path}")
    for name, importance in zip(ordered_names, importances):
        print(f"{name}: mean |effect| = {importance:.3f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
