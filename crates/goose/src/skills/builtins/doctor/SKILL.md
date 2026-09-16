---
name: doctor
description: MathModel 数学建模环境检查与安装向导。仅当用户明确要求“环境检查”“doctor”“检查依赖”“修复数学建模环境”或安装论文/绘图依赖时使用。检查 CUMCM LaTeX、Python 科学计算、科研绘图工具链与 Git，输出缺失项和按平台安装方案（含中国大陆网络的镜像方案），并只在用户明确确认后执行安装。
allowed-tools: Bash(*), Read, AskUserQuestion
---

# Doctor — 数学建模环境检查与安装向导

只在用户明确触发时运行。先做只读检测，再报告；安装任何内容前都必须获得用户确认。

## 范围

- 检查本机论文、绘图与版本存档工具链。不检查 API Key、模型供应商或网络连通性。
- **Git 只管「装没装」。** 缺失时按 `references/install.md` 引导安装，装完只跑
  `git --version` 复检。不要 `git init`、不要提交/推送、不要改动仓库内容，
  不要修改用户的 `git config`（用户名、邮箱、凭据、代理一律不碰）。
- 不把可选项缺失判定为核心环境不可用。
- 不静默安装，不静默创建虚拟环境，不修改系统 Python。

## 检查分级

### 必需项

| 项目 | 用途 |
| --- | --- |
| Python 3 | 建模求解与绘图脚本 |
| `git` | MathModel 的本地项目版本存档与回合快照恢复 |
| `xelatex` | `mma-paper` 的 CUMCM 中文 LaTeX 模板 |
| `latexmk` | 论文自动多轮编译 |
| `bibtex` | 参考文献编译 |
| `numpy`, `scipy`, `pandas` | 数值计算、优化与数据处理 |
| `matplotlib`, `seaborn`, `python-dateutil` | 内置绘图模板与科研图 |

### 建议项

| 项目 | 用途 |
| --- | --- |
| `uv` | Python、虚拟环境与依赖管理；MathModel 安装包通常自带 |
| `drawio` / `draw.io` | 技术路线图与流程图导出 |
| `pdftoppm` / `mutool` / `magick` 任一 | PDF 转图片后的视觉检查 |
| 可用中文字体 | SimSun、STSong、Songti SC 或 Noto Serif CJK SC |

### 按需项

- `typst`：用户选择 Typst 论文工作流时。
- `Rscript`：用户在 `nature-figure` 中明确选择 R 时。
- `dot`：使用 Graphviz 时。
- 地理空间绘图模板：`cartopy`, `shapely`。
- Python 扩展包：`scikit-learn`, `openpyxl`, `plotnine`, `plotly`, `networkx`,
  `shap`, `optuna`, `geopandas`, `folium`, `graphviz`, `wordcloud`。

## 工作流

### 1. 确定当前项目使用的 Python

优先检查当前项目虚拟环境，不要默认使用或修改系统 Python：

```bash
if [ -x .venv/bin/python ]; then
  PYTHON=.venv/bin/python
elif [ -x .venv/Scripts/python.exe ]; then
  PYTHON=.venv/Scripts/python.exe
elif command -v python3 >/dev/null 2>&1; then
  PYTHON=python3
elif command -v python >/dev/null 2>&1; then
  PYTHON=python
else
  echo "MISS python"
fi
```

Windows 上 shell 为 PowerShell 时用等价探测（后续命令中 `"$PYTHON"` 同样换成
PowerShell 变量写法）：

```powershell
if (Test-Path .venv\Scripts\python.exe) { $PYTHON = ".venv\Scripts\python.exe" }
elseif (Get-Command python -ErrorAction SilentlyContinue) { $PYTHON = "python" }
elseif (Get-Command python3 -ErrorAction SilentlyContinue) { $PYTHON = "python3" }
else { Write-Output "MISS python" }
```

如果没有 Python，先报告这一项，继续用 `command -v`（PowerShell 用 `Get-Command`）
检查 LaTeX 和建议工具；不要尝试运行 Python 检查脚本。

### 2. 运行结构化检查

定位本 Skill 所在目录，也就是包含本 `SKILL.md` 的 `doctor` 目录，然后运行：

```bash
"$PYTHON" "<doctor-skill-directory>/scripts/check_environment.py"
```

脚本只读取命令路径、当前 Python 包和字体信息，不安装、不联网、不修改配置。

### 3. 按工作流解释结果

- `summary.coreReady=true`：CUMCM LaTeX + Python 核心环境可用。
- `missingRequired`：必须修复，否则论文编译或内置绘图流程会中断。
- `missingRecommended`：展示影响，但不要阻断核心工作流。
- `optional`：只有用户明确要用对应功能时才建议安装。
- `fonts.installed=false`：提醒中文图表可能出现方框；不要仅凭字体名称假定可用。

用户只选择 Python 绘图时，不要求 R；用户只写 LaTeX 论文时，不要求 Typst。

### 4. 输出简洁报告

按以下格式汇总，不粘贴整段 JSON：

```text
Doctor 检查完成（macOS arm64）

核心环境：未就绪
✓ Python 3.12.x
✗ xelatex — CUMCM 中文论文无法编译
✓ numpy 2.x
✗ scipy — 优化与科学计算不可用

建议项：DrawIO 缺失；PDF 预览可用（pdftoppm）
按需项：R 未安装（不影响当前 Python 工作流）
```

### 5. 网络环境判断

给出安装方案前先探测直连网络（5 秒超时，只发 HEAD 请求不下载）：

```bash
curl -sI -m 5 https://github.com >/dev/null 2>&1 && echo "OK github" || echo "SLOW github"
curl -sI -m 5 https://pypi.org/simple/ >/dev/null 2>&1 && echo "OK pypi" || echo "SLOW pypi"
```

任一探测失败或超时，或用户说明自己处于中国大陆网络时，后续安装命令一律改用
[`references/install.md`](references/install.md) 的「中国大陆网络环境（镜像）」
方案；探测正常则用默认源。在报告和安装确认里注明本次采用了哪套源，
不要混用两套命令。

### 6. 安装前询问

先列出将执行的准确命令、下载体积或权限影响，再用 `AskUserQuestion` 询问一次：

- `立即安装必需项（Recommended）`
- `只显示安装命令`
- `暂不处理`

用户没有明确选择“立即安装”时，只能显示命令。安装命令见
[`references/install.md`](references/install.md)。不要默认安装全部可选绘图库。

### 7. 安装与复检

- 优先用 `uv` 创建/维护项目 `.venv`，不要对系统 Python 执行全局 `pip install`。
- 系统包安装可能请求管理员权限；执行前明确说明。
- 每类安装完成后检查退出码。失败时停止该类后续安装并报告最后一条有效错误。
- 安装完成后，用同一个 Python 解释器重新运行 `scripts/check_environment.py`。
- **Windows 复检要当心 PATH 快照**：安装器把新目录写进注册表后，当前已运行的
  shell 与 agent 进程仍是旧 PATH，`git`、`xelatex` 直接敲会「找不到」，看起来
  像装失败。这时用绝对路径复检（例如 `& "C:\Program Files\Git\cmd\git.exe" --version`），
  并告诉用户 MathModel「设置 → 运行环境」点「重新检查」即可识别，不必重启电脑。
- 只有复检通过后才能声称环境已就绪。

## R 后端补充检查

仅当用户已选择 R 时执行：

```bash
Rscript -e 'pkgs <- c("ggplot2","patchwork","ggrepel","svglite","ragg"); for (p in pkgs) cat(if (requireNamespace(p, quietly=TRUE)) "OK" else "MISS", p, "\n")'
```

`ComplexHeatmap` 来自 Bioconductor，单独报告，不要与 CRAN 包混装或静默安装。
