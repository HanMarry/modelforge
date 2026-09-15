from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("MPLCONFIGDIR", str(ROOT / ".mplconfig"))

import matplotlib as mpl

mpl.use("Agg")

import matplotlib.pyplot as plt
import numpy as np

COLORS = ["#287C8E", "#D58B52", "#7774A6", "#668D62"]


def configure_matplotlib() -> None:
    mpl.rcParams.update(
        {
            "font.family": "DejaVu Sans",
            "font.size": 10,
            "axes.spines.top": False,
            "axes.spines.right": False,
            "axes.labelcolor": "#263742",
            "text.color": "#263742",
            "axes.prop_cycle": mpl.cycler(color=COLORS),
            "legend.frameon": False,
            "pdf.fonttype": 42,
            "svg.fonttype": "none",
        }
    )


def export(fig: plt.Figure, output_stem: Path) -> None:
    fig.supxlabel("Deterministic demonstration data", fontsize=8, color="#68757D")
    output_stem.parent.mkdir(parents=True, exist_ok=True)
    for suffix in (".png", ".pdf", ".svg"):
        fig.savefig(output_stem.with_suffix(suffix), dpi=300, bbox_inches="tight")
    plt.close(fig)


def principal_components(
    values: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Standardize columns, then return scores, eigenvectors and variance fractions."""
    values = np.asarray(values, dtype=float)
    if values.ndim != 2 or min(values.shape) < 2 or not np.isfinite(values).all():
        raise ValueError(
            "PCA requires a finite sample-by-feature matrix with at least two rows and columns"
        )
    scale = values.std(axis=0, ddof=1)
    if np.any(scale == 0):
        raise ValueError("Remove constant features before PCA")
    standardized = (values - values.mean(axis=0)) / scale
    u, singular, vectors = np.linalg.svd(standardized, full_matrices=False)
    # Fix sign ambiguity so previews remain stable across linear algebra backends.
    signs = np.sign(vectors[np.arange(len(vectors)), np.abs(vectors).argmax(axis=1)])
    vectors *= signs[:, None]
    scores = u * singular * signs
    return scores, vectors, singular**2 / np.sum(singular**2)


def make_figure(output_stem: Path) -> None:
    configure_matplotlib()
    rng = np.random.default_rng(731)
    groups = np.repeat(np.arange(3), 45)
    latent = rng.normal(size=(135, 2)) + np.array([[-2, 0], [1, 2], [2, -2]])[groups]
    values = latent @ rng.normal(size=(2, 6)) + rng.normal(0, 0.45, (135, 6))
    scores, vectors, ratio = principal_components(values)
    fig, axes = plt.subplots(
        1,
        3,
        figsize=(13.2, 4.1),
        layout="constrained",
        gridspec_kw={"width_ratios": [1.3, 1, 1]},
    )
    for group, color in enumerate(COLORS[:3]):
        axes[0].scatter(
            *scores[groups == group, :2].T,
            s=24,
            alpha=0.75,
            color=color,
            label=f"Group {group + 1}",
            edgecolors="white",
            linewidths=0.3,
        )
    axes[0].axhline(0, color="#DDE3E6", lw=0.8, zorder=0)
    axes[0].axvline(0, color="#DDE3E6", lw=0.8, zorder=0)
    axes[0].set(
        xlabel=f"PC1 ({ratio[0]:.1%})",
        ylabel=f"PC2 ({ratio[1]:.1%})",
        title="a  Sample structure",
    )
    axes[0].legend(fontsize=8)
    components = np.arange(1, len(ratio) + 1)
    axes[1].bar(components, ratio * 100, color=COLORS[0], alpha=0.8, label="Individual")
    axes[1].plot(
        components, np.cumsum(ratio) * 100, "o-", color=COLORS[1], label="Cumulative"
    )
    axes[1].set(
        xlabel="Principal component",
        ylabel="Explained variance (%)",
        ylim=(0, 105),
        xticks=components,
        title="b  Variance retained",
    )
    axes[1].legend(fontsize=8)
    bound = np.abs(vectors[:2]).max()
    heat = axes[2].imshow(
        vectors[:2].T, cmap="RdBu_r", vmin=-bound, vmax=bound, aspect="auto"
    )
    axes[2].set(
        xticks=[0, 1],
        xticklabels=["PC1", "PC2"],
        yticks=np.arange(6),
        yticklabels=[f"Feature {i + 1}" for i in range(6)],
        title="c  Component weights",
    )
    fig.colorbar(heat, ax=axes[2], label="Eigenvector coefficient", shrink=0.8)
    export(fig, output_stem)


if __name__ == "__main__":
    make_figure(ROOT / "outputs" / "pca_variance_report_replica")
