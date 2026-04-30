#!/usr/bin/env python3

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path


def load_dotenv(path: Path) -> dict[str, str]:
    env: dict[str, str] = {}

    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()

        if not line or line.startswith("#"):
            continue

        if line.startswith("export "):
            line = line[len("export ") :].strip()

        if "=" not in line:
            continue

        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()

        if not key:
            continue

        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]

        env[key] = value

    return env


def main() -> int:
    if len(sys.argv) < 2:
        print(
            "Usage: python3 scripts/run_with_dotenv.py <command> [args...]",
            file=sys.stderr,
        )
        return 1

    root = Path(__file__).resolve().parents[1]
    dotenv_path = root / ".env"

    env = os.environ.copy()

    if dotenv_path.exists():
        env.update(load_dotenv(dotenv_path))

    result = subprocess.run(sys.argv[1:], cwd=root, env=env)
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
