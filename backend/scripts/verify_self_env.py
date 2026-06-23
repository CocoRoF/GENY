"""Deterministic smoke test for the self-modifying environment (no LLM).

Builds a real Geny preset pipeline and exercises every ``env`` action through
the SAME code path a live session uses — including the per-call dispatch
context — so you can confirm the capability end-to-end without spending tokens.

Run inside the backend container:

    docker exec -e PYTHONPATH=/app geny-backend-prod \
        python /app/scripts/verify_self_env.py [preset-id]

Default preset: template-worker-env. Try template-vtuber-env to see that tool/
skill/settings/config edits work for the persona too (prompt edit is worker-only).
"""

import asyncio
import sys

from geny_executor.core.state import PipelineState
from service.environment.service import EnvironmentService
from service.executor.geny_tool_provider import GenyToolProvider
from service.tool_loader import ToolLoader
from service.tool_settings import get_tool_setting_schemas


def _check(label, cond):
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}")
    return cond


async def main(preset_id: str) -> None:
    print(f"=== self-modifying environment :: {preset_id} ===")
    is_vtuber = "vtuber" in preset_id.lower()
    tl = ToolLoader()
    tl.load_all()
    # Mirror the session manager's wiring: GenyToolProvider (get-style) +
    # SkillToolProvider (MCP-style). instantiate_pipeline routes each to the
    # right executor channel so skills surface + the controller finds them.
    from service.skills import attach_provider, install_skill_registry
    skreg, _ = install_skill_registry(role="vtuber" if is_vtuber else "worker")
    providers = [GenyToolProvider(tl)]
    sp = attach_provider(skreg)
    if sp is not None:
        providers.append(sp)
    svc = EnvironmentService()
    pipe = await svc.instantiate_pipeline(
        preset_id, api_key="sk-test", adhoc_providers=providers, strict=False,
    )
    pipe.attach_runtime(env_settings_schemas=get_tool_setting_schemas())
    # The worker path installs a MutablePromptBuilder at session build (prompt
    # editable); the VTuber path keeps DynamicPersona (prompt edit reports
    # locked — by design). Mirror that here so the test reflects real sessions.
    if not is_vtuber:
        from geny_executor.stages.s03_system.builders import MutablePromptBuilder
        pipe.attach_runtime(system_builder=MutablePromptBuilder("you are a worker"))
    env = pipe.environment

    ok = True
    print("\n1) controller + env tool reach the live dispatch context")
    stage = next(s for s in pipe._stages.values() if getattr(s, "name", "") == "tool")
    ok &= _check("env tool active", pipe.tool_registry.get("env") is not None)
    ctx = stage.build_dispatch_context(PipelineState(session_id="probe"))
    ok &= _check("env controller reaches dispatch ctx", ctx.environment is env)

    print("\n2) tools — enable/disable (disable fully removes it next turn)")
    snap = env.snapshot()
    v0 = pipe.tool_registry.version
    if env.available_tools():
        name = env.available_tools()[0]
        env.enable_tool(name)
        ok &= _check(f"enable_tool({name})", name in env.active_tools())
    some = next((t for t in env.active_tools() if t != "env"), None)
    if some:
        env.disable_tool(some)
        ok &= _check(f"disable_tool({some}) removed", some not in env.active_tools())
    ok &= _check("registry version bumped (Stage 3 refreshes next turn)",
                 pipe.tool_registry.version != v0)
    ok &= _check("env tool is self-protected", not env.disable_tool("env")[0])

    print("\n3) tool settings — set an API key, confirm it reaches the next call")
    env.set_setting("web_search", "brave_api_key", "TEST-KEY-1234")
    ctx2 = stage.build_dispatch_context(PipelineState(session_id="probe"))
    ok &= _check("setting reaches dispatch extras",
                 ctx2.extras.get("web_search", {}).get("brave_api_key") == "TEST-KEY-1234")
    masked = env.get_settings()["groups"].get("web_search", {}).get("brave_api_key", "")
    ok &= _check(f"secret masked in get_settings ({masked!r})", "TEST-KEY-1234" not in masked)

    print("\n4) config — tunables editable, core (model/provider) locked")
    ok &= _check("set temperature=0.5", env.set_config("temperature", 0.5)[0])
    ok &= _check("set max_iterations=12", env.set_config("max_iterations", 12)[0])
    ok &= _check("model is REFUSED (core)", not env.set_config("model", "x")[0])
    ok &= _check("provider is REFUSED (core)", not env.set_config("provider", "openai")[0])

    print("\n5) prompt (worker: editable; VTuber: DynamicPersona, locked)")
    p_ok = env.set_prompt("you are a test persona")[0]
    if is_vtuber:
        print(f"  [{'PASS' if not p_ok else 'WARN'}] set_prompt locked (expected for VTuber)")
        ok &= (not p_ok)
    else:
        ok &= _check("set_prompt editable (worker)", p_ok)

    print("\n6) skills — surfaced as tools + author a new one")
    surfaced = [n for n in pipe.tool_registry.list_names() if n in set(
        env._skill_registry.list_ids() if env._skill_registry else [])]
    ok &= _check(f"baseline skills surfaced as tools ({len(surfaced)})", len(surfaced) > 0)
    env.create_skill("probe-skill", "a probe", "# Probe\nstep 1.")
    ok &= _check("create_skill enabled it", "probe-skill" in env.active_skills())
    if surfaced:
        ok &= _check(f"disable_skill({surfaced[0]})", env.disable_skill(surfaced[0])[0])

    print("\n7) overlay (what env_save persists) + changelog")
    ov = env.overlay()
    ok &= _check("overlay carries tool_settings", "web_search" in (ov.get("tool_settings") or {}))
    ok &= _check("overlay carries config", bool(ov.get("config", {}).get("model")))
    ok &= _check("changelog recorded edits", len(env.changelog()) >= 5)

    print(f"\n=== {'ALL PASS' if ok else 'SOME FAILED'} ({preset_id}) ===")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1] if len(sys.argv) > 1 else "template-worker-env"))
