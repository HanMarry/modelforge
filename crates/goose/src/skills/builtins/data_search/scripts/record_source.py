#!/usr/bin/env python3
"""Record provenance for a downloaded project data file."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import tempfile
from datetime import date
from pathlib import Path
from urllib.parse import urlparse


SCHEMA_VERSION = 1


def http_url(value: str) -> str:
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise argparse.ArgumentTypeError("URL must use http or https")
    return value


def iso_date(value: str) -> str:
    try:
        return date.fromisoformat(value).isoformat()
    except ValueError as error:
        raise argparse.ArgumentTypeError("date must use YYYY-MM-DD") from error


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def project_file(project: Path, value: str) -> tuple[Path, str]:
    candidate = Path(value)
    absolute = (candidate if candidate.is_absolute() else project / candidate).resolve()
    try:
        relative = absolute.relative_to(project)
    except ValueError as error:
        raise SystemExit("data file must be inside the project directory") from error
    if not absolute.is_file():
        raise SystemExit(f"data file does not exist: {relative.as_posix()}")
    return absolute, relative.as_posix()


def load_manifest(path: Path) -> dict[str, object]:
    if not path.exists():
        return {"schemaVersion": SCHEMA_VERSION, "sources": []}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise SystemExit(f"cannot read existing manifest: {error}") from error
    if not isinstance(payload, dict) or payload.get("schemaVersion") != SCHEMA_VERSION:
        raise SystemExit("unsupported data/sources.json schema")
    if not isinstance(payload.get("sources"), list):
        raise SystemExit("data/sources.json sources must be an array")
    return payload


def atomic_write(path: Path, payload: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix="sources-", suffix=".json", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", default=".", help="project directory (default: current)")
    parser.add_argument("--file", required=True, help="downloaded file inside the project")
    parser.add_argument("--source-url", required=True, type=http_url)
    parser.add_argument("--landing-page-url", type=http_url)
    parser.add_argument("--title", required=True)
    parser.add_argument("--publisher", required=True)
    parser.add_argument("--license")
    parser.add_argument("--coverage")
    parser.add_argument("--notes")
    parser.add_argument("--retrieved-at", type=iso_date, default=date.today().isoformat())
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    project = Path(args.project).expanduser().resolve()
    if not project.is_dir():
        raise SystemExit(f"project directory does not exist: {project}")
    absolute, relative = project_file(project, args.file)
    manifest_path = project / "data" / "sources.json"
    manifest = load_manifest(manifest_path)

    sources = [item for item in manifest["sources"] if isinstance(item, dict)]
    previous = next((item for item in sources if item.get("file") == relative), {})
    record: dict[str, object] = {
        **previous,
        "file": relative,
        "title": args.title,
        "publisher": args.publisher,
        "sourceUrl": args.source_url,
        "retrievedAt": args.retrieved_at,
        "bytes": absolute.stat().st_size,
        "sha256": sha256(absolute),
    }
    optional = {
        "landingPageUrl": args.landing_page_url,
        "license": args.license,
        "coverage": args.coverage,
        "notes": args.notes,
    }
    record.update({key: value for key, value in optional.items() if value})

    sources = [item for item in sources if item.get("file") != relative]
    sources.append(record)
    sources.sort(key=lambda item: str(item.get("file", "")))
    manifest["sources"] = sources
    atomic_write(manifest_path, manifest)

    print(
        json.dumps(
            {"manifest": "data/sources.json", "file": relative, "sha256": record["sha256"]},
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
