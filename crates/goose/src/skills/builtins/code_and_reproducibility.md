---
name: code-and-reproducibility
description: 组织建模代码，保证结果可重生成。当开始写代码、整理项目目录，或用户说"代码怎么放""复现""跑不出来"时使用。含目录布局、uv 锁依赖、随机种子、参数外置到 config.yaml、每个数字落 results/、环境记录与 README 写成运行说明。
---

# Code and Reproducibility

Use this skill whenever you write the code that produces a paper's numbers. The standard
is simple: **another person, on another machine, following your README, gets the same
numbers.** Everything below serves that.

## Requirements

```bash
uv init --python 3.12
uv add numpy pandas scipy matplotlib
uv add --dev ruff pytest
```

`uv` writes a `uv.lock` that pins every transitive dependency — that lock file is what
makes "same environment" true, so commit it.

## Step 1 — Use one layout, every time

```
project/
├── README.md            # how to run it, in order, with expected outputs
├── pyproject.toml       # dependencies (uv)
├── uv.lock              # committed, never hand-edited
├── config.yaml          # every tunable parameter, no magic numbers in code
├── data/
│   ├── raw/             # read-only originals, never modified
│   └── processed/       # generated; safe to delete and rebuild
├── code/
│   ├── q1_prepare.py
│   ├── q2_model.py
│   ├── q3_validate.py
│   └── common.py        # shared loaders and plotting helpers
├── figures/             # generated
└── results/             # generated tables and numbers
```

Number the scripts in execution order. A reader should be able to run them top to bottom
without guessing.

## Step 2 — Keep parameters in config, not in code

```yaml
# config.yaml
seed: 20240912
data:
  raw: data/raw/production.xlsx
  sheet: Sheet1
model:
  method: milp
  time_limit_s: 60
sensitivity:
  perturbation: 0.10
  parameters: [machine_hours, material_price]
```

Then `config = yaml.safe_load(open("config.yaml"))` and pass values. This is what makes
the sensitivity analysis possible without editing code, and it is what lets a reviewer
see what you actually ran.

## Step 3 — Fix every random seed, and say where

- Seed numpy: `np.random.default_rng(cfg["seed"])` (the modern generator, not the legacy
  `np.random.seed`).
- Seed any library that samples: `random_state=` for sklearn, `seed=` for mealpy, the seed
  argument for `train_test_split`.
- For metaheuristics, one seed is not enough — run 10+ and report the distribution.
- **Record the seed in the paper.** "We used seed 20240912" is one sentence and makes the
  result reproducible.

## Step 4 — Print every number the paper cites

The paper must not contain a number that did not come out of a run. Give each script a
`results/` output:

```python
summary = {
    "objective": float(pulp.value(problem.objective)),
    "feasible": all(check_constraints(x)),
    "gap": relative_gap,
}
results_dir = Path("results")
results_dir.mkdir(exist_ok=True)
(results_dir / "q2_summary.json").write_text(
    json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8"
)
print(json.dumps(summary, ensure_ascii=False, indent=2))
```

Then copy numbers into the paper from that file. If a number in the paper cannot be
traced to a `results/` artefact, treat it as an error.

Write output files with `encoding="utf-8"` explicitly: on Windows the default is a legacy
code page, and Chinese labels will raise `UnicodeEncodeError` or produce mojibake.

## Step 5 — Guard the things that silently go wrong

```python
def require(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(f"FAILED: {message}")
```

Check, and fail loudly, on: input file missing, expected column absent, solver status not
optimal, integration `success` flag false, a validation set not beating the naive
baseline. A script that prints a warning and continues produces a paper with wrong
numbers in it.

Never write `except Exception: pass`. If a step can legitimately fail, catch that specific
exception and record what happened.

## Step 6 — Record the environment

The paper's appendix (or a `results/environment.txt`) should carry:

```
python: 3.12.7
uv.lock hash: <sha256 of uv.lock>
numpy 2.x.y, scipy 1.x.y, matplotlib 3.x.y
solver: CBC 2.10.3 / HiGHS 1.x
platform: Windows 11 / TeX Live 2024
```

Generate it rather than typing it:

```python
import platform, sys, numpy, scipy
print(sys.version, platform.platform())
print("numpy", numpy.__version__, "scipy", scipy.__version__)
```

## Step 7 — Write the README as run instructions

```markdown
# <project>

## Reproduce
1. `uv sync`                          # installs the pinned environment
2. `python code/q1_prepare.py`        # writes data/processed/*.csv
3. `python code/q2_model.py`          # writes results/q2_summary.json
4. `python code/q3_validate.py`       # writes figures/*.pdf and sensitivity.csv

## Expected outputs
| File | What it contains | Paper table |
|---|---|---|
| results/q2_summary.json | optimal plan, objective, gap | Table 2 |
```

If a step needs something not covered by `uv sync` (a solver binary, a LaTeX install),
say so in the README rather than letting the reader discover it from a stack trace.

## Rules

- Never commit `data/processed/` or `results/` as the only copy of a result — they must be
  regenerable from `data/raw/` plus the code.
- Never modify `data/raw/`. Derived files go elsewhere.
- Never leave a magic number in the code that a reviewer would want to change; put it in
  `config.yaml`.
- Never present a number that is not reproducible from a committed script.
- Never rely on the ambient environment: pin versions, and record them.
- If a step takes hours, save its output to disk so the next step does not recompute it,
  and say how long it took in the README.
