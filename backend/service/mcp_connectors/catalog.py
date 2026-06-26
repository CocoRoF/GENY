"""MCP Connector Registry — config-gated connectors to the MCP ecosystem.

A *connector* = a curated, configurable MCP server (GitHub / Notion / Composio /
a generic custom one / …). The user enables + configures it (token / url) from the
frontend; at session build Geny appends the connector's executor ``mcp_server`` dict
to ``manifest.tools.mcp_servers`` ONLY when it is enabled + its required fields are
set (progressive disclosure — the gate is *omission*). The executor then connects it
and its MCP tools appear in the session.

This is the Geny side; geny-executor already speaks MCP (``MCPManager`` /
``manifest.tools.mcp_servers``). Each connector's config is a hidden ``BaseConfig``
(``connector_<id>``) generated from this catalog, so it reuses the whole config
system (DB storage, validity, ``compute_satisfied_config`` tokens) + the
``/api/config/{name}`` endpoints, and is surfaced via the dedicated Connectors UI.

Distinct from ``service.executor.connector_bridge`` (desktop WebSocket inverse-MCP).
"""

from __future__ import annotations

import dataclasses
from logging import getLogger
from typing import Any, Callable, Dict, List, Optional

logger = getLogger(__name__)


@dataclasses.dataclass
class ConnectorField:
    name: str
    label: str
    required: bool = True
    secure: bool = True
    placeholder: str = ""
    description: str = ""


@dataclasses.dataclass
class Connector:
    id: str
    name: str
    description: str
    icon: str
    transport: str  # "http" | "stdio" (stdio needs node/npx in the backend image)
    fields: List[ConnectorField]
    # values(dict of field->str) -> executor mcp_server dict (name/transport/...)
    build: Callable[[Dict[str, str]], Dict[str, Any]]
    docs_url: str = ""

    @property
    def config_name(self) -> str:
        return f"connector_{self.id}"

    @property
    def required_token(self) -> str:
        return f"config:{self.config_name}"


# ── Curated catalog ────────────────────────────────────────────────────────
# HTTP (remote) connectors work on any deployment. stdio (npx) connectors spawn a
# local subprocess in the backend container and therefore need node/npx present.

def _http_bearer(name: str, url: str, token_field: str = "token"):
    def _b(v: Dict[str, str]) -> Dict[str, Any]:
        return {
            "name": name,
            "transport": "http",
            "url": (v.get("url") or url).strip(),
            "headers": {"Authorization": f"Bearer {v.get(token_field, '').strip()}"},
        }
    return _b


CATALOG: List[Connector] = [
    # The universal escape hatch: connect ANY remote MCP server from the UI.
    Connector(
        id="custom_http",
        name="Custom MCP (HTTP)",
        description="Connect any remote MCP server by URL (+ optional Bearer token).",
        icon="plug",
        transport="http",
        fields=[
            ConnectorField("url", "Server URL", required=True, secure=False,
                           placeholder="https://example.com/mcp/"),
            ConnectorField("token", "Bearer Token (optional)", required=False),
        ],
        build=lambda v: {
            "name": "custom_mcp",
            "transport": "http",
            "url": v.get("url", "").strip(),
            **({"headers": {"Authorization": f"Bearer {v['token'].strip()}"}}
               if v.get("token") else {}),
        },
    ),
    Connector(
        id="github",
        name="GitHub",
        description="GitHub's hosted MCP — repos, issues, PRs, code search.",
        icon="github",
        transport="http",
        docs_url="https://github.com/github/github-mcp-server",
        fields=[ConnectorField("token", "Personal Access Token", placeholder="github_pat_…")],
        build=_http_bearer("github", "https://api.githubcopilot.com/mcp/"),
    ),
    Connector(
        id="notion",
        name="Notion",
        description="Notion MCP (npx) — search, read, create pages + databases. Needs node; the hosted endpoint uses OAuth, so this uses the token-based server.",
        icon="notion",
        transport="stdio",
        docs_url="https://github.com/makenotion/notion-mcp-server",
        fields=[ConnectorField("token", "Integration Token", placeholder="ntn_…")],
        build=lambda v: {
            "name": "notion",
            "transport": "stdio",
            "command": "npx",
            "args": ["-y", "@notionhq/notion-mcp-server"],
            "env": {"NOTION_TOKEN": v.get("token", "").strip()},
        },
    ),
    Connector(
        id="composio",
        name="Composio",
        description="Composio MCP — one endpoint to 1000+ app toolkits. Paste your Composio MCP URL.",
        icon="boxes",
        transport="http",
        docs_url="https://composio.dev",
        fields=[
            ConnectorField("url", "Composio MCP URL", required=True, secure=False,
                           placeholder="https://mcp.composio.dev/…"),
            ConnectorField("api_key", "API Key (optional)", required=False),
        ],
        build=lambda v: {
            "name": "composio",
            "transport": "http",
            "url": v.get("url", "").strip(),
            **({"headers": {"Authorization": f"Bearer {v['api_key'].strip()}"}}
               if v.get("api_key") else {}),
        },
    ),
    # stdio (npx) connectors — require node/npx in the backend image.
    Connector(
        id="slack",
        name="Slack",
        description="Slack MCP (npx) — channels, messages, users. Needs node in the backend image.",
        icon="slack",
        transport="stdio",
        docs_url="https://github.com/modelcontextprotocol/servers/tree/main/src/slack",
        fields=[
            ConnectorField("bot_token", "Bot Token", placeholder="xoxb-…"),
            ConnectorField("team_id", "Team ID", secure=False, placeholder="T01234567"),
        ],
        build=lambda v: {
            "name": "slack",
            "transport": "stdio",
            "command": "npx",
            "args": ["-y", "@modelcontextprotocol/server-slack"],
            "env": {
                "SLACK_BOT_TOKEN": v.get("bot_token", "").strip(),
                "SLACK_TEAM_ID": v.get("team_id", "").strip(),
            },
        },
    ),
    Connector(
        id="postgres",
        name="PostgreSQL",
        description="Postgres MCP (npx) — read-only SQL over a connection string. Needs node.",
        icon="database",
        transport="stdio",
        fields=[ConnectorField("connection_string", "Connection URI", required=True,
                               placeholder="postgresql://user:pass@host:5432/db")],
        build=lambda v: {
            "name": "postgres",
            "transport": "stdio",
            "command": "npx",
            "args": ["-y", "@modelcontextprotocol/server-postgres", v.get("connection_string", "").strip()],
        },
    ),
    Connector(
        id="brave",
        name="Brave Search",
        description="Brave Search MCP (npx) — web search. Needs node in the backend image.",
        icon="search",
        transport="stdio",
        fields=[ConnectorField("api_key", "Brave API Key")],
        build=lambda v: {
            "name": "brave_search",
            "transport": "stdio",
            "command": "npx",
            "args": ["-y", "@brave/brave-search-mcp-server"],
            "env": {"BRAVE_API_KEY": v.get("api_key", "").strip()},
        },
    ),
    Connector(
        id="filesystem",
        name="Filesystem",
        description="Filesystem MCP (npx) — read/write files under an allowed directory. Needs node.",
        icon="folder",
        transport="stdio",
        docs_url="https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
        fields=[ConnectorField("path", "Allowed directory", required=True, secure=False,
                               placeholder="/data/shared")],
        build=lambda v: {
            "name": "filesystem",
            "transport": "stdio",
            "command": "npx",
            "args": ["-y", "@modelcontextprotocol/server-filesystem", v.get("path", "").strip()],
        },
    ),
]

CATALOG_BY_ID: Dict[str, Connector] = {c.id: c for c in CATALOG}


# ── Dynamic per-connector hidden BaseConfig (reuses the config system) ──────

def _register_connector_configs() -> None:
    from service.config.base import BaseConfig, ConfigField, FieldType, register_config

    for c in CATALOG:
        # dataclass fields: enabled + each connector field (all str, default "")
        df: List[tuple] = [("enabled", bool, dataclasses.field(default=False))]
        for f in c.fields:
            df.append((f.name, str, dataclasses.field(default="")))

        def _fields_meta(cls, _c=c):  # noqa: ANN001
            out = [ConfigField(name="enabled", field_type=FieldType.BOOLEAN,
                               label="Enabled", default=False, group="connector")]
            for f in _c.fields:
                out.append(ConfigField(
                    name=f.name,
                    field_type=FieldType.PASSWORD if f.secure else FieldType.STRING,
                    label=f.label, description=f.description, placeholder=f.placeholder,
                    required=f.required, secure=f.secure, group="connector",
                ))
            return out

        ns = {
            "get_config_name": classmethod(lambda cls, _id=c.id: f"connector_{_id}"),
            "get_display_name": classmethod(lambda cls, _n=c.name: _n),
            "get_description": classmethod(lambda cls, _d=c.description: _d),
            "get_category": classmethod(lambda cls: "connectors"),
            "get_icon": classmethod(lambda cls, _i=c.icon: _i),
            "is_user_visible": classmethod(lambda cls: False),
            "get_fields_metadata": classmethod(_fields_meta),
        }
        cls = dataclasses.make_dataclass(
            f"Connector_{c.id}_Config", df, bases=(BaseConfig,), namespace=ns,
        )
        register_config(cls)


_registered = False


def ensure_registered() -> None:
    global _registered
    if _registered:
        return
    try:
        _register_connector_configs()
        _registered = True
    except Exception as e:  # noqa: BLE001
        logger.warning("connector config registration failed: %s", e)


def _connector_values(connector: Connector) -> Optional[Dict[str, str]]:
    """Load a connector's stored config values if enabled + all required set, else None."""
    from service.config import get_config_manager

    mgr = get_config_manager()
    classes = mgr.get_registered_config_classes()
    cls = classes.get(connector.config_name)
    if cls is None:
        return None
    try:
        cfg = mgr.load_config(cls)
    except Exception:  # noqa: BLE001
        return None
    if not getattr(cfg, "enabled", False):
        return None
    values = {f.name: (getattr(cfg, f.name, "") or "") for f in connector.fields}
    for f in connector.fields:
        if f.required and not values.get(f.name):
            return None
    return values


def configured_mcp_servers() -> List[Dict[str, Any]]:
    """Executor ``mcp_server`` dicts for every enabled + fully-configured connector.
    Appended (gated) to a session's ``manifest.tools.mcp_servers`` at build time."""
    ensure_registered()
    servers: List[Dict[str, Any]] = []
    for c in CATALOG:
        vals = _connector_values(c)
        if vals is None:
            continue
        try:
            srv = c.build(vals)
            if srv.get("name") and (srv.get("url") or srv.get("command")):
                servers.append(srv)
        except Exception as e:  # noqa: BLE001
            logger.warning("connector %s build failed: %s", c.id, e)
    return servers


def catalog_status() -> List[Dict[str, Any]]:
    """Catalog + per-connector configured/enabled state for the UI (no secrets)."""
    ensure_registered()
    from service.config import get_config_manager

    mgr = get_config_manager()
    classes = mgr.get_registered_config_classes()
    out: List[Dict[str, Any]] = []
    for c in CATALOG:
        enabled = False
        configured = False
        cls = classes.get(c.config_name)
        if cls is not None:
            try:
                cfg = mgr.load_config(cls)
                enabled = bool(getattr(cfg, "enabled", False))
                configured = all(
                    (getattr(cfg, f.name, "") or "") for f in c.fields if f.required
                )
            except Exception:  # noqa: BLE001
                pass
        out.append({
            "id": c.id, "name": c.name, "description": c.description, "icon": c.icon,
            "transport": c.transport, "docs_url": c.docs_url,
            "config_name": c.config_name,
            "enabled": enabled, "configured": configured,
            "fields": [
                {"name": f.name, "label": f.label, "required": f.required,
                 "secure": f.secure, "placeholder": f.placeholder, "description": f.description}
                for f in c.fields
            ],
        })
    return out


__all__ = [
    "Connector",
    "ConnectorField",
    "CATALOG",
    "CATALOG_BY_ID",
    "ensure_registered",
    "configured_mcp_servers",
    "catalog_status",
]
