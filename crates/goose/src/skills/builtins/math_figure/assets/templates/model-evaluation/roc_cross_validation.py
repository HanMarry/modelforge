"""Cross-validated ROC curves with a confidence band.

Draws one ROC curve per fold plus the mean curve and a shaded ±1 SD band, which is
what reviewers expect when a model's discrimination is reported.

Run directly (uv resolves matplotlib, no environment to prepare)::

    uv run --with matplotlib python roc_cross_validation.py -o out/roc.pdf

Writes ``out/roc.pdf`` and ``out/roc.png``. Exit code 2 means matplotlib is
missing, so a caller can distinguish "not installed" from "script failed".
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np  # noqa: E402

from _style import (PALETTE, SERIES, apply_style, draw_note, enable_utf8_stdout, resolve_cjk_font, save_figure)  # noqa: E402


def roc_curve_points(y_true: np.ndarray, scores: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """ROC points via a descending score sweep, without sklearn."""
    order = np.argsort(-scores)
    y_sorted = y_true[order]
    positives = y_sorted.sum()
    negatives = y_sorted.size - positives
    if positives == 0 or negatives == 0:
        raise ValueError("ROC needs both classes present")

    tp = np.cumsum(y_sorted)
    fp = np.cumsum(1 - y_sorted)
    tpr = np.concatenate([[0.0], tp / positives])
    fpr = np.concatenate([[0.0], fp / negatives])
    return fpr, tpr


def auc(fpr: np.ndarray, tpr: np.ndarray) -> float:
    """Trapezoidal area under the curve.

    `np.trapezoid` is the numpy>=2 spelling; older wheels only have `np.trapz`.
    """
    integrate = getattr(np, "trapezoid", None) or np.trapz
    return float(integrate(tpr, fpr))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("-o", "--output", default="out/roc.pdf", help="vector output path")
    parser.add_argument("-k", "--folds", type=int, default=5, help="number of CV folds")
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
    label = (
        {
            "x": "假阳性率 (1 - 特异度)",
            "y": "真阳性率 (灵敏度)",
            "title": "交叉验证 ROC 曲线（{folds} 折）",
            "chance": "随机猜测",
            "mean": "均值 ROC (AUC = {auc:.3f} ± {std:.3f})",
            "fold": "第 {index} 折 (AUC = {auc:.3f})",
            "note": "演示数据（合成），替换为你的模型输出即可",
        }
        if use_zh
        else {
            "x": "False positive rate (1 - specificity)",
            "y": "True positive rate (sensitivity)",
            "title": "Cross-validated ROC ({folds} folds)",
            "chance": "Chance",
            "mean": "Mean ROC (AUC = {auc:.3f} ± {std:.3f})",
            "fold": "Fold {index} (AUC = {auc:.3f})",
            "note": "Demo data (synthetic) — replace with your model outputs",
        }
    )

    apply_style(font_scale=1.0)

    rng = np.random.default_rng(args.seed)
    grid = np.linspace(0.0, 1.0, 200)
    folds_tpr: list[np.ndarray] = []
    fold_aucs: list[float] = []

    for fold in range(args.folds):
        n = 320
        y_true = rng.integers(0, 2, size=n)
        # Signal strength varies per fold so the band has a realistic width.
        strength = 0.42 + 0.05 * fold
        scores = np.clip(y_true * strength + rng.normal(0.5, 0.24, size=n), 0.001, 0.999)
        fpr, tpr = roc_curve_points(y_true, scores)
        fold_aucs.append(auc(fpr, tpr))
        # Resample each fold onto the common grid to build the band.
        folds_tpr.append(np.interp(grid, fpr, tpr))

    stacked = np.vstack(folds_tpr)
    mean_tpr = stacked.mean(axis=0)
    std_tpr = stacked.std(axis=0)
    mean_auc = float(np.mean(fold_aucs))
    std_auc = float(np.std(fold_aucs))

    fig, ax = plt.subplots(figsize=(4.2, 3.6))

    ax.fill_between(
        grid,
        np.clip(mean_tpr - std_tpr, 0, 1),
        np.clip(mean_tpr + std_tpr, 0, 1),
        color=SERIES[1],
        alpha=0.18,
        linewidth=0,
        label="±1 SD",
    )

    for index, tpr in enumerate(folds_tpr):
        ax.plot(
            grid,
            tpr,
            color=PALETTE["tertiary"],
            linewidth=0.9,
            alpha=0.9,
            label=label["fold"].format(index=index + 1, auc=fold_aucs[index]),
        )

    ax.plot(
        grid,
        mean_tpr,
        color=PALETTE["accent"],
        linewidth=2.0,
        label=label["mean"].format(auc=mean_auc, std=std_auc),
    )
    ax.plot([0, 1], [0, 1], color=PALETTE["secondary"], linewidth=1.0, linestyle="--", label=label["chance"])

    ax.set_xlim(0, 1)
    ax.set_ylim(0, 1.02)
    ax.set_xlabel(label["x"])
    ax.set_ylabel(label["y"])
    ax.set_title(label["title"].format(folds=args.folds))
    ax.legend(loc="lower right", fontsize=7)
    fig.tight_layout()
    draw_note(fig, label["note"])
    written = save_figure(fig, args.output)
    plt.close(fig)

    for path in written:
        print(f"wrote {path}")
    print(f"mean AUC = {mean_auc:.4f} ± {std_auc:.4f} over {args.folds} folds")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
