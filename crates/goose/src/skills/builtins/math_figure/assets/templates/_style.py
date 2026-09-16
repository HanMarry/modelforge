"""Shared styling for the modeling figure templates.

Every template script imports this module so the exported vector files look like a
matching set. It is deliberately dependency-light: matplotlib only, no seaborn, no
network access.

Usage from a template script (they live one level below this file)::

    import sys
    from pathlib import Path
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from _style import PALETTE, apply_style, save_figure

The palette matches the ModelForge brand colours.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import matplotlib
import matplotlib.pyplot as plt
from matplotlib import font_manager

#: Brand palette: slate for structure, orange for emphasis.
PALETTE = {
    "primary": "#333D4A",
    "secondary": "#6B7683",
    "tertiary": "#AAB2BB",
    "accent": "#E87A3E",
    "highlight": "#2F7D8C",
    "grid": "#D8DDE2",
    "background": "#FFFFFF",
}

#: Categorical colours for series, ordered for maximum separation in print.
SERIES = ["#333D4A", "#E87A3E", "#2F7D8C", "#8E6C9E", "#B4413C", "#6B7683"]

#: Preferred CJK families, first installed one wins. Ordered by how commonly the
#: font ships with TeX Live, Windows and macOS respectively.
_CJK_CANDIDATES = [
    "Noto Sans CJK SC",
    "Noto Sans CJK JP",
    "Source Han Sans SC",
    "Microsoft YaHei",
    "SimHei",
    "PingFang SC",
    "Heiti SC",
    "WenQuanYi Zen Hei",
    "FandolHei",
]


def resolve_cjk_font() -> str | None:
    """Return the first installed CJK-capable family, or None.

    Chinese axis labels are required by the competition templates; when no CJK
    font is installed the caller should fall back to English labels rather than
    emit a figure full of missing-glyph boxes.
    """
    installed = {font.name for font in font_manager.fontManager.ttflist}
    for name in _CJK_CANDIDATES:
        if name in installed:
            return name
    return None


def apply_style(font_family: str | None = None, *, font_scale: float = 1.0) -> None:
    """Apply the shared rcParams. Safe to call once per script."""
    matplotlib.rcParams.update(
        {
            "figure.facecolor": PALETTE["background"],
            "axes.facecolor": PALETTE["background"],
            "savefig.facecolor": PALETTE["background"],
            "axes.edgecolor": PALETTE["secondary"],
            "axes.labelcolor": PALETTE["primary"],
            "axes.titlecolor": PALETTE["primary"],
            "axes.grid": True,
            "grid.color": PALETTE["grid"],
            "grid.linewidth": 0.6,
            "axes.axisbelow": True,
            "axes.spines.top": False,
            "axes.spines.right": False,
            "text.color": PALETTE["primary"],
            "xtick.color": PALETTE["secondary"],
            "ytick.color": PALETTE["secondary"],
            "xtick.labelsize": 8 * font_scale,
            "ytick.labelsize": 8 * font_scale,
            "axes.labelsize": 9 * font_scale,
            "axes.titlesize": 10 * font_scale,
            "legend.fontsize": 8 * font_scale,
            "legend.frameon": False,
            "figure.dpi": 110,
            "savefig.bbox": "tight",
            "savefig.pad_inches": 0.05,
            "lines.linewidth": 1.4,
            "lines.markersize": 3.5,
            "font.size": 9 * font_scale,
        }
    )

    family = font_family or resolve_cjk_font()
    if family:
        # Append rather than replace so Latin text keeps the default face and the
        # CJK font only supplies the glyphs it owns.
        matplotlib.rcParams["font.sans-serif"] = [family]
        matplotlib.rcParams["font.family"] = "sans-serif"
        matplotlib.rcParams["axes.unicode_minus"] = False


def save_figure(fig, path: str | os.PathLike[str], *, also_png: bool = True) -> list[Path]:
    """Save a figure as vector PDF/SVG plus an optional PNG preview.

    Returns the paths actually written. The extension of ``path`` decides the
    vector format; the PNG gets the same stem.
    """
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)

    written: list[Path] = []
    fig.savefig(target)
    written.append(target)

    if also_png:
        preview = target.with_suffix(".png")
        fig.savefig(preview, dpi=160)
        written.append(preview)

    return written


def enable_utf8_stdout() -> None:
    """Make console output safe for non-ASCII metric names.

    On Windows the console defaults to a legacy code page (GBK, cp1252, …), so
    printing `R²` or a Chinese label raises UnicodeEncodeError *after* the figure has
    been written — which looks like a crash even though the output is fine. Every
    template calls this before printing.
    """
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is None:
            continue
        try:
            reconfigure(encoding="utf-8", errors="replace")
        except (ValueError, OSError):
            pass


def draw_note(fig, text: str, *, y: float = -0.015) -> None:
    """Place a small note under the whole figure.

    Using figure coordinates keeps the note clear of legends and axis labels,
    which placed-in-axes notes tend to collide with.
    """
    fig.text(
        0.01,
        y,
        text,
        fontsize=6.5,
        color=PALETTE["secondary"],
        ha="left",
        va="top",
    )


# --- Diagram helpers -------------------------------------------------------
#
# Flowchart and framework templates share these so every diagram has the same
# shapes, spacing and arrowheads. They draw on an axes in *data* coordinates and
# expect the caller to set the limits, so layout numbers read like millimetres on
# a page rather than fractions of an axes.

#: Tint used for the secondary block fill, derived from the palette.
BLOCK_FILL = "#F1F4F6"
BLOCK_FILL_ACCENT = "#FBEADF"


def diagram_axes(figsize: tuple[float, float] = (7.2, 5.0)):
    """Create an axes with no ticks or spines, ready for block layout."""
    import matplotlib.pyplot as plt

    fig, ax = plt.subplots(figsize=figsize)
    ax.set_xticks([])
    ax.set_yticks([])
    ax.grid(False)
    for spine in ax.spines.values():
        spine.set_visible(False)
    return fig, ax


def block(
    ax,
    x: float,
    y: float,
    width: float,
    height: float,
    text: str,
    *,
    fill: str | None = None,
    edge: str | None = None,
    text_color: str | None = None,
    fontsize: float = 8.0,
    weight: str = "normal",
    radius: float = 0.12,
    line_spacing: float = 1.35,
):
    """Rounded rectangle with centred, wrapped text.

    Returns the patch so callers can attach arrows to its coordinates.
    """
    from matplotlib.patches import FancyBboxPatch

    fill = fill or BLOCK_FILL
    edge = edge or PALETTE["secondary"]
    text_color = text_color or PALETTE["primary"]

    patch = FancyBboxPatch(
        (x, y),
        width,
        height,
        boxstyle=f"round,pad=0,rounding_size={radius}",
        linewidth=0.9,
        edgecolor=edge,
        facecolor=fill,
        zorder=2,
    )
    ax.add_patch(patch)
    ax.text(
        x + width / 2,
        y + height / 2,
        text,
        ha="center",
        va="center",
        fontsize=fontsize,
        color=text_color,
        fontweight=weight,
        linespacing=line_spacing,
        zorder=3,
    )
    return patch


def arrow(ax, start: tuple[float, float], end: tuple[float, float], *, color: str | None = None, style: str = "->"):
    """Straight arrow between two points, drawn under the blocks."""
    from matplotlib.patches import FancyArrowPatch

    patch = FancyArrowPatch(
        start,
        end,
        arrowstyle=style,
        mutation_scale=9,
        linewidth=0.9,
        color=color or PALETTE["secondary"],
        shrinkA=0,
        shrinkB=0,
        zorder=1,
    )
    ax.add_patch(patch)
    return patch


def title_and_note(ax, title: str, note: str, *, note_y: float = -0.14):
    """Consistent title plus the demo-data note for diagram templates."""
    ax.set_title(title, fontsize=11, color=PALETTE["primary"], pad=10)
    ax.text(
        0.0,
        note_y,
        note,
        transform=ax.transAxes,
        fontsize=6.5,
        color=PALETTE["secondary"],
        ha="left",
        va="top",
    )


def demo_dataset(seed: int = 20240912):
    """Deterministic synthetic data for the templates.

    Templates ship with synthetic data on purpose: they must run without the
    user's own dataset, and no real modelling data may be redistributed. Values
    are clearly labelled as a demo in every figure.
    """
    import numpy as np

    rng = np.random.default_rng(seed)
    y_true = rng.integers(0, 2, size=400)
    scores = np.clip(
        y_true * 0.45 + rng.normal(0.5, 0.22, size=y_true.size),
        0.01,
        0.99,
    )
    return y_true, scores
