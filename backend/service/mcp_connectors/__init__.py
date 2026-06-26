"""MCP Connector Registry — config-gated connectors to the MCP ecosystem.

Enable + configure a connector (GitHub / Notion / Composio / custom / …) from the
UI; its MCP server is injected into a session only when configured, and the
executor connects it so its tools appear. See :mod:`service.mcp_connectors.catalog`.
"""

from service.mcp_connectors.catalog import (
    CATALOG,
    CATALOG_BY_ID,
    Connector,
    ConnectorField,
    catalog_status,
    configured_mcp_servers,
    ensure_registered,
)

__all__ = [
    "Connector",
    "ConnectorField",
    "CATALOG",
    "CATALOG_BY_ID",
    "ensure_registered",
    "configured_mcp_servers",
    "catalog_status",
]
