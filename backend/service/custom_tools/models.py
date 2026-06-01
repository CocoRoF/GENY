"""Pydantic shapes for ``CustomToolDefinition`` and its three backend configs.

The DB row (``CustomToolModel``) stores the JSON-dumped form of these
shapes. The store + controller validate at write time; ToolLoader
trusts what it reads (the validator already ran).

Design notes:

* HTTP backend uses ``${arg:name}`` / ``${secret:KEY}`` / ``${session:field}``
  placeholders. ``${arg:*}`` interpolates from the LLM-supplied
  arguments; ``${secret:*}`` resolves against host settings at dispatch
  time (the placeholder text never lands in the DB); ``${session:*}``
  reads from the trusted ``ToolContext`` (only ``session_id`` is
  exposed today, the same set as :data:`tools.base.INJECTED_PARAM_NAMES`).
* ``input_schema`` is the schema the LLM sees. The adapter forces
  ``"additionalProperties": false`` and strips
  :data:`tools.base.INJECTED_PARAM_NAMES` regardless of what the user
  supplied so a hand-edited schema can't reopen the W1/W10 holes
  closed in PR #847.
* ``capabilities`` mirrors ``geny_executor.tools.base.ToolCapabilities``
  fields — the executor's Stage-10 reads these for retry / concurrency
  / result-size gating.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Literal, Optional, Union

from pydantic import BaseModel, Field, field_validator, model_validator


# ── Backend configs ──────────────────────────────────────────────


class ToolCapabilities(BaseModel):
    """Lean mirror of ``geny_executor.tools.base.ToolCapabilities``.

    Defaults are fail-closed (mirroring the executor): unless the
    author opts in, Stage-10 assumes the tool is *not* read-only,
    *not* idempotent, and *not* safe to run concurrently.
    """

    concurrency_safe: bool = False
    read_only: bool = False
    idempotent: bool = False
    network_egress: bool = False
    max_result_chars: int = 8_000


class HttpToolConfig(BaseModel):
    """Configuration for an HTTP-backed custom tool."""

    method: Literal["GET", "POST", "PUT", "DELETE", "PATCH"] = "POST"
    url_template: str = Field(
        ...,
        description=(
            "URL template with ``${arg:name}`` placeholders for LLM "
            "arguments and ``${secret:KEY}`` for host-resolved secrets."
        ),
    )
    headers: Dict[str, str] = Field(
        default_factory=dict,
        description="Request headers. Values may reference ${secret:KEY}.",
    )
    body_template: Optional[str] = Field(
        default=None,
        description=(
            "Body template. Most commonly a JSON string with "
            "``${arg:*}`` placeholders. ``None`` → empty body."
        ),
    )
    timeout_seconds: int = Field(default=30, ge=1, le=600)
    response_handler: Literal["json", "text", "sse_stream_collect"] = "json"
    sse_done_marker: Optional[str] = Field(
        default=None,
        description=(
            "When ``response_handler='sse_stream_collect'`` — the SSE "
            "``event:`` or ``data:`` marker that signals the stream "
            "is done so the adapter can stop reading."
        ),
    )

    @field_validator("url_template")
    @classmethod
    def _url_must_be_http(cls, v: str) -> str:
        if not v.startswith(("http://", "https://")):
            raise ValueError(
                "url_template must start with http:// or https://"
            )
        return v


class McpProxyConfig(BaseModel):
    """Re-export an existing MCP tool under a new name / metadata."""

    upstream_mcp_server: str = Field(
        ...,
        description="Name of the registered MCP server (see /api/mcp/custom).",
    )
    upstream_tool_name: str = Field(
        ...,
        description="Tool name as advertised by the upstream MCP server.",
    )
    schema_overlay: Optional[Dict[str, Any]] = Field(
        default=None,
        description=(
            "Optional partial JSON-Schema merged over the upstream "
            "tool's inputSchema. Use to hide arguments or tighten types."
        ),
    )


class BuiltinAliasConfig(BaseModel):
    """Metadata overlay on a Python tool living in ``backend/tools/custom``.

    Used by Phase D to ship the existing ``blog_agent_*`` tools as
    Custom-Tools samples without moving any Python code. The adapter
    re-uses the BaseTool instance from the loader and only overrides
    the description / examples / capabilities shown to the LLM.
    """

    source_module: str = Field(
        ...,
        description=(
            "ToolLoader source stem — e.g. ``blog_agent_tools`` for "
            "``backend/tools/custom/blog_agent_tools.py``."
        ),
    )
    source_class: str = Field(
        ...,
        description="BaseTool subclass name in that module.",
    )
    description_override: Optional[str] = None
    examples_override: Optional[List[Dict[str, Any]]] = None


CustomToolConfig = Union[HttpToolConfig, McpProxyConfig, BuiltinAliasConfig]


# ── Top-level definition ─────────────────────────────────────────


class CustomToolDefinition(BaseModel):
    """User-facing custom-tool record.

    Mirrors :class:`service.tool_preset.models.ToolPresetDefinition`'s
    shape conventions: ULID-ish ``id``, top-level metadata, JSON config
    nested under ``config``.
    """

    id: str = Field(default_factory=lambda: uuid.uuid4().hex)
    name: str = Field(
        ...,
        min_length=1,
        max_length=64,
        pattern=r"^[a-z][a-z0-9_]*$",
        description=(
            "LLM-visible tool name. Lowercase, snake_case, ASCII. "
            "Must not collide with a built-in or another custom tool."
        ),
    )
    description: str = Field(
        ...,
        min_length=1,
        max_length=4_000,
        description="Description shown to the LLM in the tool list.",
    )
    input_schema: Dict[str, Any] = Field(
        default_factory=lambda: {
            "type": "object",
            "properties": {},
            "required": [],
            "additionalProperties": False,
        },
        description=(
            "JSON Schema the LLM sees. Host-injected params (see "
            ":data:`tools.base.INJECTED_PARAM_NAMES`) are stripped by "
            "the adapter on every load."
        ),
    )
    backend_kind: Literal["http", "mcp_proxy", "builtin_alias"]
    config: CustomToolConfig
    capabilities: ToolCapabilities = Field(default_factory=ToolCapabilities)
    enabled: bool = True
    is_sample: bool = False
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

    @model_validator(mode="after")
    def _kind_matches_config(self) -> "CustomToolDefinition":
        # pydantic's discriminated unions are sensitive to model order;
        # we do the cross-field check explicitly so an HttpToolConfig
        # in a row marked ``backend_kind="mcp_proxy"`` fails loudly
        # instead of silently coercing.
        kind_to_cls = {
            "http": HttpToolConfig,
            "mcp_proxy": McpProxyConfig,
            "builtin_alias": BuiltinAliasConfig,
        }
        expected = kind_to_cls.get(self.backend_kind)
        if expected is not None and not isinstance(self.config, expected):
            raise ValueError(
                f"backend_kind={self.backend_kind!r} requires "
                f"config of type {expected.__name__}, "
                f"got {type(self.config).__name__}"
            )
        return self

    @model_validator(mode="after")
    def _enforce_schema_hygiene(self) -> "CustomToolDefinition":
        # Force the W1/W10 invariants on every write. A hand-rolled
        # schema can never escape them — the loader applies the same
        # treatment on read, but writing them in keeps DB rows
        # self-describing.
        from tools.base import INJECTED_PARAM_NAMES

        schema = self.input_schema or {}
        if not isinstance(schema, dict):
            raise ValueError("input_schema must be a JSON object")
        schema.setdefault("type", "object")
        schema.setdefault("properties", {})
        schema.setdefault("required", [])
        schema["additionalProperties"] = False

        props = schema.get("properties", {})
        required = schema.get("required", [])
        if not isinstance(props, dict) or not isinstance(required, list):
            raise ValueError("input_schema.properties and .required malformed")

        for hidden in INJECTED_PARAM_NAMES:
            props.pop(hidden, None)
        schema["required"] = [r for r in required if r not in INJECTED_PARAM_NAMES]
        self.input_schema = schema
        return self
