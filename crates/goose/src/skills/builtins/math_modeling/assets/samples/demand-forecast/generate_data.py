"""Generate the synthetic monthly demand series for the demand-forecast sample problem.

Includes the features the problem asks about: an upward trend, annual seasonality, a
Chinese-New-Year dip, a few missing values and one anomalous spike.

Usage:
    uv run --with numpy --with pandas python generate_data.py
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

SEED = 20240912
MONTHS = 60
DATA_DIR = Path(__file__).resolve().parent / "data"


def main() -> int:
    rng = np.random.default_rng(SEED)
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    index = np.arange(MONTHS)
    # Trend + annual cycle + noise.
    trend = 820 + 2.6 * index
    seasonal = 70 * np.sin(2 * np.pi * (index % 12) / 12)
    noise = rng.normal(0, 18, MONTHS)

    # Chinese New Year falls in month 2 for the first three years of this series.
    spring_festival = np.isin(index % 12, [1]) & (index < 36)
    festival_dip = np.where(spring_festival, -95.0, 0.0)

    demand = trend + seasonal + noise + festival_dip

    # One anomalous month: a cold snap pushes demand up sharply.
    spike_index = 41
    demand[spike_index] += 180

    # A few missing readings, as a real utility series would have.
    missing = [17, 34, 52]
    values = demand.astype(object)
    for position in missing:
        values[position] = np.nan

    dates = pd.period_range("2020-01", periods=MONTHS, freq="M")
    monthly = pd.DataFrame(
        {
            "period": dates.astype(str),
            "month_index": index,
            "month_of_year": (index % 12) + 1,
            "demand_10k_kwh": values,
        }
    )
    monthly.to_csv(DATA_DIR / "demand_monthly.csv", index=False, encoding="utf-8-sig")

    calendar = pd.DataFrame(
        {
            "period": dates.astype(str),
            "spring_festival": spring_festival.astype(int),
        }
    )
    calendar.to_csv(DATA_DIR / "calendar.csv", index=False, encoding="utf-8-sig")

    print(
        f"wrote {MONTHS} months: {len(missing)} missing values at {missing}, "
        f"spike at index {spike_index}"
    )
    print(f"output -> {DATA_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
