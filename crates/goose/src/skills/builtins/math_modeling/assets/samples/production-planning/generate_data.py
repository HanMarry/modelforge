"""Generate the synthetic dataset for the production-planning sample problem.

Deterministic: the same seed always produces the same files, so a paper's numbers can
be reproduced from this script alone.

Usage:
    uv run --with numpy --with pandas python generate_data.py
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

SEED = 20240912
DATA_DIR = Path(__file__).resolve().parent / "data"

PRODUCTS = ["甲", "乙", "丙"]


def main() -> int:
    rng = np.random.default_rng(SEED)
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    # Per-unit consumption, profit and emissions. Figures are plausible but synthetic.
    products = pd.DataFrame(
        {
            "product": PRODUCTS,
            "machine_hours": [1.8, 2.6, 1.2],
            "material_kg": [3.2, 1.4, 2.1],
            "labour_hours": [0.9, 1.6, 0.6],
            "profit_per_unit": [42.0, 63.0, 28.0],
            "co2_per_unit_kg": [5.4, 8.1, 3.2],
        }
    )
    products.to_csv(DATA_DIR / "products.csv", index=False, encoding="utf-8-sig")

    # Resource limits: tight enough that the optimum is a genuine trade-off, not
    # "produce the maximum of everything".
    resources = pd.DataFrame(
        {
            "resource": ["machine_hours", "material_kg", "labour_hours"],
            "available": [2400.0, 3600.0, 1500.0],
            "unit": ["小时", "千克", "小时"],
        }
    )
    resources.to_csv(DATA_DIR / "resources.csv", index=False, encoding="utf-8-sig")

    # Demand window per product: a lower bound the factory will not go below and an
    # upper bound the market will not absorb beyond.
    demand = pd.DataFrame(
        {
            "product": PRODUCTS,
            "min_units": [180, 120, 260],
            "max_units": [720, 560, 900],
        }
    )
    demand.to_csv(DATA_DIR / "demand.csv", index=False, encoding="utf-8-sig")

    # A short historical series so the sensitivity question has something to be
    # sensitive about, and so students can sanity-check the LP against recent behaviour.
    history = pd.DataFrame(
        {
            "quarter": [f"2024Q{i}" for i in range(1, 9)],
            "profit": np.round(18_000 + rng.normal(0, 900, 8), 1),
            "co2_total_kg": np.round(2_400 + rng.normal(0, 120, 8), 1),
        }
    )
    history.to_csv(DATA_DIR / "history.csv", index=False, encoding="utf-8-sig")

    print(f"wrote {len(products)} product rows, {len(resources)} resource rows, "
          f"{len(demand)} demand rows, {len(history)} history rows to {DATA_DIR}")
    print("data is synthetic and generated for practice; do not present it as real")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
