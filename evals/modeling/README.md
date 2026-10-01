# 建模评测集

规格 mathmodel-parity-and-beyond 需求 23 的评测集：3 道原创练习题（优化类、预测/统计类、综合评价类各 1 道），每题一个目录。

| 文件 | 内容 |
|---|---|
| `<题目>/task.yaml` | 运行器读取的 `eval` 段与 goose recipe |
| `<题目>/checks.yaml` | 人工制定的检查项，`method` 为 `file`、`baseline` 或 `manual` |
| `<题目>/baseline.json` | 关键数值的参考值与允许误差 |
| `learning-samples/` | 学习模式抽样对话（需求 20.3），只出报告 |
| `run.mts` | 运行器，用法见文件头注释；CI 中由 `.github/workflows/modelforge-evals.yml` 调用 |
| `results/` | 结果文件与人工复核记录 |

## 结果文件

运行器把每次运行写成 `results/<开始时间>.json`，记录 Build_Manifest 的 commit 与 dirty、逐题检查结论、耗时与 token 用量。`file` 与 `baseline` 检查由运行器判定；`manual` 检查记为“待人工”，不计入通过数。结果文件入库后不再手改。

## 人工复核

“待人工”的检查项由人对照论文判定，记录在结果文件旁：

- `results/<开始时间>.manual-review.json`：判定以它为准。
- `results/<开始时间>.manual-review.md`：同一内容的可读版。

一份复核记录对应一个结果文件中的一个模型，要求：

1. 判定该模型每道完成题的全部“待人工”检查项，只能判“通过”或“未通过”；不复核、也不改动自动判定的检查项。
2. 每项写 `evidence`（论文 `paper.tex` 行号或 `paper.pdf` 页码、代码文件与行号、数值复算结果）；判“未通过”的项另写 `failures`，说明缺了哪个要素或哪里与数据不符。不影响判定的附带问题写 `defects`；判定依赖解释的项标 `borderline: true`。
3. 判定标准写在 `standard` 字段。拿不准时判“未通过”，并写明原因。
4. 写明 `reviewer`、`reviewedAt`（ISO 8601，含时区）、结果文件的 `resultSha256` 与 `commit`，以及所依据产物的 artifact digest 与文件 SHA256（`artifact`）。用户签核后把 `signedOff` 改为 `true` 并补 `signedOffBy`、`signedOffAt`。
5. 逐题与总计的 `summary`：`automatic` 取自结果文件，`manual` 取自复核记录，`passed`、`failed` 为两者之和，`pending` 为仍未判定的项数，`total` 为检查项总数。未完成的题（失败或已中止）全部检查项计为未通过（需求 23.7）。

`ui/desktop/src/utils/evals/evalManualReview.test.ts` 逐份核对复核记录与结果文件：结果文件的 SHA256 与 commit、每个“待人工”项恰好判定一次、证据与未通过原因齐全、各级计数正确，以及 `.md` 可读版存在。该测试随桌面端测试在 CI 中运行。
