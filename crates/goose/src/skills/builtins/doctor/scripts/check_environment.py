#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.metadata
import importlib.util
import json
import os
import platform
import shutil
import sys
import tempfile
from typing import Any


def git_candidates() -> tuple[str, ...]:
    """Git 的候选命令。

    Windows 的 PATH 是进程启动时的快照：装完 Git for Windows 后，本进程仍是
    旧 PATH，只查 `git` 会误报未安装。补上安装器的默认位置作为候选
    （shutil.which 对带路径分隔符的参数会直接校验该路径）。
    """
    if os.name != "nt":
        return ("git",)
    bases = [
        os.environ.get("ProgramFiles"),
        os.environ.get("ProgramW6432"),
        os.environ.get("ProgramFiles(x86)"),
        os.path.join(os.environ["LOCALAPPDATA"], "Programs")
        if os.environ.get("LOCALAPPDATA")
        else None,
    ]
    fallbacks = [
        os.path.join(base, "Git", sub, "git.exe")
        for base in dict.fromkeys(filter(None, bases))
        for sub in ("cmd", "bin")
    ]
    return ("git", *fallbacks)


REQUIRED_TOOLS = (
    ("git", git_candidates(), "local project version snapshots"),
    ("xelatex", ("xelatex",), "CUMCM Chinese LaTeX compiler"),
    ("latexmk", ("latexmk",), "automatic multi-pass LaTeX build"),
    ("bibtex", ("bibtex",), "bibliography compiler"),
)

RECOMMENDED_TOOLS = (
    ("uv", ("uv",), "Python and environment manager"),
    ("drawio", ("drawio", "draw.io"), "flowchart export"),
    ("pdf-preview", ("pdftoppm", "mutool", "magick"), "PDF visual QA"),
)

OPTIONAL_TOOLS = (
    ("typst", ("typst",), "Typst paper workflow"),
    ("r", ("Rscript",), "nature-figure R backend"),
    ("graphviz", ("dot",), "Graphviz diagrams"),
)

REQUIRED_PACKAGES = (
    ("numpy", "numpy"),
    ("scipy", "scipy"),
    ("pandas", "pandas"),
    ("matplotlib", "matplotlib"),
    ("seaborn", "seaborn"),
    ("dateutil", "python-dateutil"),
)

OPTIONAL_PACKAGES = (
    ("cartopy", "cartopy"),
    ("shapely", "shapely"),
    ("sklearn", "scikit-learn"),
    ("openpyxl", "openpyxl"),
    ("plotnine", "plotnine"),
    ("plotly", "plotly"),
    ("networkx", "networkx"),
    ("shap", "shap"),
    ("optuna", "optuna"),
    ("geopandas", "geopandas"),
    ("folium", "folium"),
    ("graphviz", "graphviz"),
    ("wordcloud", "wordcloud"),
)

FONT_CANDIDATES = ("SimSun", "STSong", "Songti SC", "Noto Serif CJK SC")


def command_status(
    tool_id: str, candidates: tuple[str, ...], level: str, purpose: str
) -> dict[str, Any]:
    matches = [{"command": command, "path": shutil.which(command)} for command in candidates]
    found = [match for match in matches if match["path"]]
    return {
        "id": tool_id,
        "level": level,
        "purpose": purpose,
        "installed": bool(found),
        "selected": found[0] if found else None,
        "candidates": matches,
    }


def package_status(module: str, distribution: str, level: str) -> dict[str, Any]:
    installed = importlib.util.find_spec(module) is not None
    version = None
    if installed:
        try:
            version = importlib.metadata.version(distribution)
        except importlib.metadata.PackageNotFoundError:
            version = None
    return {
        "module": module,
        "distribution": distribution,
        "level": level,
        "installed": installed,
        "version": version,
    }


def font_status(matplotlib_installed: bool) -> dict[str, Any]:
    if not matplotlib_installed:
        return {
            "checked": False,
            "installed": False,
            "matches": [],
            "candidates": list(FONT_CANDIDATES),
            "reason": "matplotlib is unavailable",
        }
    try:
        with tempfile.TemporaryDirectory(prefix="mathmodel-doctor-") as cache_dir:
            previous_config_dir = os.environ.get("MPLCONFIGDIR")
            os.environ["MPLCONFIGDIR"] = cache_dir
            try:
                from matplotlib import font_manager

                available = {font.name for font in font_manager.fontManager.ttflist}
            finally:
                if previous_config_dir is None:
                    os.environ.pop("MPLCONFIGDIR", None)
                else:
                    os.environ["MPLCONFIGDIR"] = previous_config_dir

        matches = [name for name in FONT_CANDIDATES if name in available]
        return {
            "checked": True,
            "installed": bool(matches),
            "matches": matches,
            "candidates": list(FONT_CANDIDATES),
            "reason": None,
        }
    except Exception as error:  # A broken font cache should be reported, not crash doctor.
        return {
            "checked": False,
            "installed": False,
            "matches": [],
            "candidates": list(FONT_CANDIDATES),
            "reason": str(error),
        }


def build_report() -> dict[str, Any]:
    tools = [
        *(
            command_status(tool_id, candidates, "required", purpose)
            for tool_id, candidates, purpose in REQUIRED_TOOLS
        ),
        *(
            command_status(tool_id, candidates, "recommended", purpose)
            for tool_id, candidates, purpose in RECOMMENDED_TOOLS
        ),
        *(
            command_status(tool_id, candidates, "optional", purpose)
            for tool_id, candidates, purpose in OPTIONAL_TOOLS
        ),
    ]
    packages = [
        *(package_status(module, distribution, "required") for module, distribution in REQUIRED_PACKAGES),
        *(package_status(module, distribution, "optional") for module, distribution in OPTIONAL_PACKAGES),
    ]
    missing_required = [
        *(f"tool:{tool['id']}" for tool in tools if tool["level"] == "required" and not tool["installed"]),
        *(
            f"python:{package['distribution']}"
            for package in packages
            if package["level"] == "required" and not package["installed"]
        ),
    ]
    missing_recommended = [
        f"tool:{tool['id']}"
        for tool in tools
        if tool["level"] == "recommended" and not tool["installed"]
    ]
    matplotlib_installed = any(
        package["module"] == "matplotlib" and package["installed"] for package in packages
    )
    fonts = font_status(matplotlib_installed)
    if not fonts["installed"]:
        missing_recommended.append("font:Chinese serif")

    return {
        "platform": {
            "system": platform.system(),
            "release": platform.release(),
            "machine": platform.machine(),
        },
        "python": {
            "installed": True,
            "executable": sys.executable,
            "version": platform.python_version(),
        },
        "tools": tools,
        "pythonPackages": packages,
        "fonts": fonts,
        "summary": {
            "coreReady": not missing_required,
            "missingRequired": missing_required,
            "missingRecommended": missing_recommended,
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Check the MathModel paper and figure environment.")
    parser.add_argument("--compact", action="store_true", help="Emit compact JSON")
    args = parser.parse_args()
    indent = None if args.compact else 2
    print(json.dumps(build_report(), ensure_ascii=False, indent=indent, sort_keys=True))


if __name__ == "__main__":
    main()
