# 论文模板（math-paper 资产）

`math-paper` 技能用的 LaTeX/Typst 竞赛模板，共 **17 套**，全部实测可编译。
这里记录每套的入口、来源与构建前提。

应用里的首页预览是**真实编译产物**的首页，由
`ui/desktop/scripts/build-paper-previews.js` 生成（`pnpm run papers:build`）。
没跑过编译的模板一律不入库——脚本编译失败时会直接报出 LaTeX 错误日志，而不是让坏模板进仓库。

## 从产品内置模板提取（14 套）

目录结构、封面、承诺书、编号栏与章节拆分都来自已安装产品
`resources/builtin-skills/mma-paper/assets/template/` 的真实模板。
抽取过程与**逐套许可状态**记在仓库根的 `REPORT-extraction.md` 与 `NOTICE.md`。

| 目录 | 赛事 | 入口 | 随目录自带的表单字段（`template.json`） |
| --- | --- | --- | --- |
| `cumcm/` | 国赛 CUMCM | `document.tex` | 题号、参赛队号；学校/队员/指导教师 |
| `mcm/` | 美赛 MCM/ICM | `main.tex` | 题号、队伍控制号 |
| `apmcm/` | 亚太赛 APMCM（中文） | `main.tex` | 题号、队号；学校/队员 |
| `apmcm-en/` | 亚太赛 APMCM（英文） | `main.tex` | 题号、队号；学校/队员 |
| `huashubei/` | 华数杯 | `main.tex` | — |
| `mathorcup/` | MathorCup | `main.tex` | 题号、队号 |
| `shuweibei/` | 数维杯 | `main.tex` | 题号、队号 |
| `wuyi/` | 五一杯 | `main.tex` | 题号、队号、类别、日期；学校/队员/电话/邮箱 |
| `diangongbei/` | 电工杯 | `main.tex` | 题号、队号 |
| `dongsansheng/` | 东三省赛 | `main.tex` | 题号、类别；学校/队员/指导教师/电话 |
| `huazhong/` | 华中杯 | `main.tex` | 题号、队号、竞赛日期；学校/队员/指导教师 |
| `changsanjiao/` | 长三角赛 | `main.tex` | 题号、队号、类别 |
| `huawei/` | 华为杯（研究生） | `main.tex` | 队号；学校/队员 |
| `stats/` | 统计建模大赛 | `main.tex` | 年份、届次、作品编号；学校/队员/指导教师 |

每套目录里的 `template.json` 是产品自带的元数据（名称、语言、入口、封面字段），
桌面端的论文模板页直接读它来生成表单，`papers.ts` 由 `pnpm run papers:catalog` 从这些文件生成。

**嵌入字体：本测试树里全部保留**。产品模板目录自带 29 个字体（约 118 MB），
其中多数是商业中文字体（微软/中易的 KaiTi、SimSun、SimHei、LiSu，方正的 `fzxbsongti`，
以及 `YaHei.Consolas`、`MONACO`）。保留它们是为了让**编译结果与产品完全一致**：
`wuyi`、`huawei`、`huazhong` 的类文件按文件名引用这些字体，缺了就只能回退到系统字体，
版面与产品不同，测试就不准。`changsanjiao`、`diangongbei`、`shuweibei` 的 `fonts/` 目录
也因此不再是空的。

**对外分发前必须剥离**——这些字体的许可不允许再分发：

```bash
cd ui/desktop
node scripts/strip-unshippable.js            # 先看清单（默认不删任何东西）
node scripts/strip-unshippable.js --write    # 真正删除：字体 + 真题 + 许可未声明的模板
pnpm run papers:catalog && pnpm run docs:check   # 重新生成目录并核对
```

剥离后 `wuyi` 一类模板会因找不到字体而编译失败，需要改成系统字体（`Consolas` 等），
这与早期版本的做法一致。逐套许可状态见仓库根 `NOTICE.md`。

## 从上游仓库采购（3 套）

| 目录 | 赛事 | 入口 | 上游 | 许可 |
| --- | --- | --- | --- | --- |
| `cumcm-latex/` | 国赛 CUMCM | `paper.tex` | [Sustainable-Enjoyment/CUMCM-LaTeX-Template](https://github.com/Sustainable-Enjoyment/CUMCM-LaTeX-Template) | MIT |
| `jxust-latex/` | 校级赛/通用 | `paper.tex` | [sikouhjw/JXUSTmodeling](https://github.com/sikouhjw/JXUSTmodeling) | MIT |
| `cumcm-typst/` | 国赛 CUMCM（Typst） | `paper.typ` | [a-kkiri/CUMCM-typst-template](https://github.com/a-kkiri/CUMCM-typst-template)（`lib.typ`） | Apache-2.0 |

每个目录保留上游的 `LICENSE` 原文。`paper.tex` / `paper.typ` 由本项目编写；
`template.tex`、`main.tex`、`example.tex`、`figures/*.tex`、`lib.typ` 来自上游。

`cumcm-typst/theorems.typ` 替代了原模板的 `#import "@preview/ctheorems:1.1.3"`：
那次 import 会让编译**必须联网**（Typst 首次使用会去 packages.typst.org 下载），
离线机器上根本编译不出来。本文件按接口重写了 `lib.typ` 实际用到的那一个函数
（`thmbox`），不是复制 ctheorems 源码（其许可为 MIT）。`lib.typ` 只改了两处：
import 行，以及本实现用不到的 `envbox` 绑定里的 `base:` 参数。

## 编译前提（不随仓库分发）

- **TeX**：`xelatex` 与 `ctex`（中文模板）+ 常规 `amsmath`、`booktabs`、`geometry`、
  `graphicx`、`hyperref`、`caption`，TeX Live / MiKTeX 均自带。
- **中文字体**：`ctex` 会自动选字体，Fandol 或 Noto CJK 是常见回退。
- **Typst**：`cumcm-typst` 需要 `typst` 命令行（`TYPST=<path>` 可指定）。
- `cumcm-latex/` 需要 `cumcmthesis.cls` 与 `paper.tex` 同目录（已满足）。

```bash
latexmk -xelatex -interaction=nonstopmode document.tex   # 国赛
typst compile paper.typ                                  # Typst 版
```

Windows 上 TeX Live 的工具通常在
`E:\texlive2024\texlive\2024\bin\windows`，跑构建脚本前先加进 `PATH`。
环境是否就绪用 `doctor` 技能检查（内部调用 modeling 扩展的 `check_env`）。

## 未内置的来源（以及原因）

| 来源 | 原因 |
| --- | --- |
| `latexstudio/mcmthesis`（LPPL 1.3c+） | 仓库只发布 `mcmthesis.dtx`，`.cls` 是用 `xetex` 跑源文件生成的派生物，无法从仓库复现；美赛改用产品内置的 `mcm/`。 |
| `sikouhjw/MathorCupmodeling` | 仓库无 `LICENSE` 文件。 |
| `sikouhjw/CUMCMThesis`、`latexstudio/MCM-ICM` | 仓库 404。 |

## 各赛事当年度规范

各赛事的论文格式规范（封面、页数上限、编号规则）**每年可能变**。
仓库里的骨架只是起点，不构成合规保证；开工前应重新核对当年规则。

## 重新生成

```bash
cd ui/desktop
pnpm run papers:build       # 编译全部模板并刷新首页预览
pnpm run papers:catalog     # 从各模板的 template.json 重新生成 src/catalog/papers.ts
pnpm run assets:extract -- --app "<产品安装目录>"   # 重新从产品提取模板（需产品在本机）
```
