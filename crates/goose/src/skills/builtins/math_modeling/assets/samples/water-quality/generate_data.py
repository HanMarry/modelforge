"""Generate the synthetic water-quality dataset for the evaluation sample problem.

Six indicators across twelve monitoring sections, mixing benefit and cost directions
and different units, so the normalisation step is genuinely necessary.

Usage:
    uv run --with numpy --with pandas python generate_data.py
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

SEED = 20240912
DATA_DIR = Path(__file__).resolve().parent / "data"

# name, unit, direction, reference value (used for context only)
INDICATORS = [
    ("溶解氧", "mg/L", "benefit", 7.5),
    ("高锰酸盐指数", "mg/L", "cost", 4.0),
    ("化学需氧量", "mg/L", "cost", 20.0),
    ("氨氮", "mg/L", "cost", 1.0),
    ("总磷", "mg/L", "cost", 0.2),
    ("浊度", "NTU", "cost", 5.0),
]

SECTIONS = [f"S{i:02d}" for i in range(1, 13)]


def main() -> int:
    rng = np.random.default_rng(SEED)
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    rows = {}
    # Give each section a latent "quality score" so the ranking has real structure
    # rather than being pure noise, then derive indicators from it with independent
    # noise. Sections with a higher score get better readings on both directions.
    quality = np.linspace(0.15, 0.95, len(SECTIONS))

    for name, _unit, direction, reference in INDICATORS:
        if direction == "benefit":
            centre = reference * (0.7 + 0.6 * quality)
        else:
            centre = reference * (1.45 - 0.9 * quality)
        noise = rng.normal(0, 0.06 * reference, len(SECTIONS))
        rows[name] = np.round(np.clip(centre + noise, 0.01, None), 3)

    sections = pd.DataFrame({"section": SECTIONS, **rows})
    sections.to_csv(DATA_DIR / "sections.csv", index=False, encoding="utf-8-sig")

    indicators = pd.DataFrame(
        [
            {"name": name, "unit": unit, "direction": direction, "reference": reference}
            for name, unit, direction, reference in INDICATORS
        ]
    )
    indicators.to_csv(DATA_DIR / "indicators.csv", index=False, encoding="utf-8-sig")

    print(f"wrote {len(sections)} sections x {len(INDICATORS)} indicators -> {DATA_DIR}")
    print("data is synthetic and generated for practice; do not present it as real")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
