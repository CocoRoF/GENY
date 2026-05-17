"""One-off migrator: lift ``strategies['provider']`` → ``config['provider']``
on every stored environment manifest.

Phase E5 of the LLM backend upgrade. ``geny-executor>=2.0.0`` rejects
manifests that still carry ``strategies['provider']`` (the silent-
divergence location that v2.0.0 deletes), so this script walks the
EnvironmentService store, lifts every Stage 6 entry it finds, and
writes the manifest back.

Usage::

    python -m scripts.migrate_manifests_provider_location           # dry-run
    python -m scripts.migrate_manifests_provider_location --apply   # write changes
    python -m scripts.migrate_manifests_provider_location --apply --verbose

Idempotent: re-running on an already-migrated manifest is a no-op.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path
from typing import Any, Dict, List, Tuple


logger = logging.getLogger("migrate_manifests")


def _migrate_one(manifest_obj: Dict[str, Any]) -> Tuple[Dict[str, Any], bool]:
    """Return (mutated manifest, changed?). Idempotent."""
    changed = False
    stages = manifest_obj.get("stages") or []
    if not isinstance(stages, list):
        return manifest_obj, False

    for entry in stages:
        if not isinstance(entry, dict):
            continue
        if entry.get("name") != "api" and entry.get("order") != 6:
            continue
        strategies = entry.get("strategies") or {}
        config = entry.get("config") or {}
        if "provider" in strategies:
            provider_value = strategies.pop("provider")
            # config wins if already set (frontend writes there).
            if "provider" not in config:
                config["provider"] = provider_value
            entry["strategies"] = strategies
            entry["config"] = config
            changed = True
        # Force a sane default if Stage 6 is active but no provider is
        # named anywhere — anthropic is the historical default.
        elif entry.get("active", True) and "provider" not in config:
            config["provider"] = "anthropic"
            entry["config"] = config
            changed = True
    return manifest_obj, changed


def _discover_manifest_paths() -> List[Path]:
    """Best-effort enumeration of every manifest the EnvironmentService
    owns. Returns absolute paths.

    Strategy: pull the configured environments root from
    EnvironmentService and walk ``*.json`` files. If the service can't
    be imported (e.g. running from a fresh checkout without venv),
    fall back to ``~/.geny/environments/``.
    """
    try:
        from service.environment.service import EnvironmentService

        svc = EnvironmentService()
        root = Path(getattr(svc, "_root", None) or svc.root_path)
    except Exception:  # noqa: BLE001
        root = Path.home() / ".geny" / "environments"

    if not root.exists():
        return []
    return sorted(root.glob("*.json"))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true",
                        help="Write changes back. Without this flag the script is a dry-run.")
    parser.add_argument("--verbose", action="store_true",
                        help="Log per-file decisions.")
    parser.add_argument("--path", type=str, default=None,
                        help="Optional explicit path to a single manifest JSON.")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s - %(message)s",
    )

    if args.path:
        paths = [Path(args.path)]
    else:
        paths = _discover_manifest_paths()

    if not paths:
        logger.warning("no manifest files discovered")
        return 0

    changed_count = 0
    total = len(paths)
    for p in paths:
        try:
            raw = json.loads(p.read_text(encoding="utf-8"))
        except Exception as e:  # noqa: BLE001
            logger.error("skip %s: %s", p, e)
            continue
        new_obj, changed = _migrate_one(raw)
        if not changed:
            if args.verbose:
                logger.debug("ok      %s (no change)", p.name)
            continue
        changed_count += 1
        if args.apply:
            p.write_text(json.dumps(new_obj, indent=2, ensure_ascii=False), encoding="utf-8")
            logger.info("written %s", p.name)
        else:
            logger.info("would write %s", p.name)

    logger.info(
        "migration summary: %d/%d manifests changed (%s)",
        changed_count, total, "applied" if args.apply else "dry-run",
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
