"""Inbound chat gateway (Geny consumer of geny-executor's gateway).

geny-executor ≥2.11.0 owns the gateway framework + platform adapters
(Telegram). Geny supplies only:
  * a handler (``handle_inbound``) that runs one VTuber turn per chat, and
  * config (a bot token via env or settings).

See :func:`install.install_gateway` (called from the app lifespan).
"""

from service.gateway.handler import handle_inbound
from service.gateway.install import install_gateway, load_gateway_specs

__all__ = ["handle_inbound", "install_gateway", "load_gateway_specs"]
