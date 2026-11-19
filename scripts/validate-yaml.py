#!/usr/bin/env python3
"""Parse every build/deploy/gate YAML file and fail on syntax errors.

Used by CI (guardrails job) and by the local release check. This is a pure
syntax/structure parse: it does not enforce a schema, only that the files are
valid YAML and (for workflows) contain the expected top-level keys.

Requires PyYAML (`python3 -m pip install pyyaml`).
"""

from __future__ import annotations

import glob
import sys
from pathlib import Path

try:
    import yaml
except ImportError:  # pragma: no cover - CI installs it explicitly
    sys.exit("PyYAML is required: python3 -m pip install pyyaml")

ROOT = Path(__file__).resolve().parent.parent

GLOBS = [
    ".github/workflows/*.yml",
    ".github/workflows/*.yaml",
    "deploy/docker-compose*.yml",
    "deploy/docker-compose*.yaml",
    "backend/src/main/resources/application*.yml",
    "contracts/openapi.yaml",
]


def main() -> int:
    files: list[Path] = []
    for pattern in GLOBS:
        files.extend(sorted(ROOT.glob(pattern)))

    if not files:
        print("FAIL  no YAML files matched", file=sys.stderr)
        return 1

    failures = 0
    for path in files:
        rel = path.relative_to(ROOT)
        try:
            with path.open(encoding="utf-8") as handle:
                # A single safe_load is enough: duplicate keys are a PyYAML error
                # only with a custom loader, but syntax errors are always caught.
                document = yaml.safe_load(handle)
        except yaml.YAMLError as exc:
            print(f"FAIL  {rel}: {exc}")
            failures += 1
            continue

        if document is None:
            print(f"FAIL  {rel}: empty document")
            failures += 1
            continue

        if path.parent.name == "workflows":
            # GitHub parses `on` as a bool-ish key in YAML 1.1; accept both.
            keys = set(document)
            has_on = "on" in keys or True in keys
            if not has_on or "jobs" not in keys:
                print(f"FAIL  {rel}: workflow must define `on` and `jobs`")
                failures += 1
                continue

        print(f"ok    {rel}")

    if failures:
        print(f"\n{failures} YAML file(s) failed validation", file=sys.stderr)
        return 1

    print(f"\nAll {len(files)} YAML files parsed successfully")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
