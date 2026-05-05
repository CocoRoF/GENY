"""
YAML Frontmatter parser for structured memory files.

Handles reading and writing YAML frontmatter blocks (``---`` delimited)
at the top of Markdown files. Used by the direct-write archiver paths
(``DmArchiver``, ``CompactionArchiver``) whose on-disk layouts don't
fit the executor's flat-category ``NotesHandle`` contract.

Sprint 3 step 6 — the dead ``extract_wikilinks`` /  ``resolve_wikilink``
/ ``build_default_metadata`` helpers and the unused ``_DEFAULT_METADATA``
constant were dropped. ``extract_wikilinks`` lives in
``service.memory.structured_writer`` (the only caller) and the executor
itself extracts wikilinks inside ``NotesHandle`` for the indexed
write-path.
"""

from __future__ import annotations

import re
from typing import Any, Dict, Tuple

# Regex: match ``---`` delimited YAML block at file start.
_FRONTMATTER_RE = re.compile(
    r"\A\s*---[ \t]*\n(.*?\n)---[ \t]*\n",
    re.DOTALL,
)


def parse_frontmatter(content: str) -> Tuple[Dict[str, Any], str]:
    """Parse YAML frontmatter from a Markdown string.

    Args:
        content: Full Markdown file content.

    Returns:
        A tuple of ``(metadata_dict, body_text)``.
        If no frontmatter is found, metadata is an empty dict and
        body is the original content.
    """
    match = _FRONTMATTER_RE.match(content)
    if not match:
        return {}, content

    yaml_block = match.group(1)
    body = content[match.end():]

    metadata = _parse_yaml_simple(yaml_block)
    return metadata, body


def render_frontmatter(metadata: Dict[str, Any], body: str) -> str:
    """Render metadata dict + body into a full Markdown string with frontmatter.

    Args:
        metadata: Key-value metadata to serialise.
        body: Markdown body text.

    Returns:
        Complete Markdown string with ``---`` delimited YAML block.
    """
    lines = ["---"]
    for key, value in metadata.items():
        if value is None:
            continue
        lines.append(_yaml_line(key, value))
    lines.append("---")
    lines.append("")

    fm = "\n".join(lines)
    # Ensure body starts without excessive blank lines
    body = body.lstrip("\n")
    return fm + body


# ------------------------------------------------------------------
# Internal YAML helpers (avoid PyYAML dependency)
# ------------------------------------------------------------------

def _parse_yaml_simple(block: str) -> Dict[str, Any]:
    """Parse a simple YAML block without PyYAML.

    Supports:
    - ``key: value`` (string)
    - ``key: [item1, item2]`` (inline list)
    - ``key: true/false`` (boolean)
    - ``key: 123`` (integer)
    - ``key: 1.5`` (float)

    Multi-line values and nested objects are NOT supported.
    """
    result: Dict[str, Any] = {}

    for line in block.split("\n"):
        line = line.strip()
        if not line or line.startswith("#"):
            continue

        colon_idx = line.find(":")
        if colon_idx < 1:
            continue

        key = line[:colon_idx].strip()
        raw_value = line[colon_idx + 1:].strip()

        result[key] = _parse_yaml_value(raw_value)

    return result


def _parse_yaml_value(raw: str) -> Any:
    """Parse a single YAML value."""
    if not raw or raw == "~" or raw.lower() == "null":
        return None

    # Boolean
    if raw.lower() in ("true", "yes"):
        return True
    if raw.lower() in ("false", "no"):
        return False

    # Inline list: [item1, item2, ...]
    if raw.startswith("[") and raw.endswith("]"):
        inner = raw[1:-1].strip()
        if not inner:
            return []
        items = []
        for item in inner.split(","):
            item = item.strip().strip("'\"")
            if item:
                items.append(item)
        return items

    # Quoted string
    if (raw.startswith('"') and raw.endswith('"')) or \
       (raw.startswith("'") and raw.endswith("'")):
        return raw[1:-1]

    # Integer
    try:
        return int(raw)
    except ValueError:
        pass

    # Float
    try:
        return float(raw)
    except ValueError:
        pass

    return raw


def _yaml_line(key: str, value: Any) -> str:
    """Render a single YAML key-value line."""
    if isinstance(value, bool):
        return f"{key}: {'true' if value else 'false'}"
    if isinstance(value, list):
        if not value:
            return f"{key}: []"
        items = ", ".join(_yaml_scalar(v) for v in value)
        return f"{key}: [{items}]"
    if isinstance(value, (int, float)):
        return f"{key}: {value}"
    if isinstance(value, str):
        # Quote if contains special YAML chars
        if any(c in value for c in ":#{}[]|>&*!?,"):
            escaped = value.replace('"', '\\"')
            return f'{key}: "{escaped}"'
        return f"{key}: {value}"
    return f"{key}: {value}"


def _yaml_scalar(value: Any) -> str:
    """Render a scalar for inline list."""
    if isinstance(value, str):
        if any(c in value for c in ",:#{}[]|>&*!?,"):
            escaped = value.replace('"', '\\"')
            return f'"{escaped}"'
        return value
    return str(value)
