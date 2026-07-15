"""Companion runtime contract — auth propagation with a GAPT sandbox.

Regression for 2026-07-15: attaching the owner's sandbox to the companion
WITHOUT containerize_cli=False flipped the executor default (True) and ran
the companion's claude_code_cli INSIDE the gapt-ws container — its own
baked CLI binary, without the auth Geny configured — failing every
delegated turn with authentication_failed while the owner kept working.
"""

from __future__ import annotations

from types import SimpleNamespace

from service.vtuber.sub_agent_bridge import _companion_attach_kwargs


class TestCompanionAttachContract:
    def _ctx(self, **over):
        base = {
            "sub_agent_id": "owner-1-subagent",
            "working_dir": "/data/geny_agent_sessions/owner-1",
            "storage_path": "/data/geny_agent_sessions/owner-1",
            "sandbox": SimpleNamespace(container_name="gapt-ws-x"),
        }
        base.update(over)
        return base

    def test_cli_never_containerized(self):
        """THE invariant: sandbox attached → tools sandboxed, CLI on host.

        The executor default is containerize_cli=True the moment a sandbox
        is attached — the companion must pin False exactly like the owner
        (agent_session ~2951) so Geny-configured auth (host OAuth /
        in_modal_login) reaches the CLI."""
        kwargs = _companion_attach_kwargs(self._ctx())
        assert kwargs["containerize_cli"] is False
        assert kwargs["sandbox"].container_name == "gapt-ws-x"

    def test_cli_not_containerized_even_without_sandbox(self):
        """Future-proof: the pin is unconditional so a later sandbox
        attach can never implicitly flip the CLI into a container."""
        kwargs = _companion_attach_kwargs(self._ctx(sandbox=None))
        assert kwargs["containerize_cli"] is False
        assert "sandbox" not in kwargs

    def test_tool_context_carries_owner_workspace(self):
        kwargs = _companion_attach_kwargs(self._ctx())
        tc = kwargs["tool_context"]
        assert tc.session_id == "owner-1-subagent"
        assert tc.working_dir == "/data/geny_agent_sessions/owner-1"
        assert tc.storage_path == "/data/geny_agent_sessions/owner-1"
