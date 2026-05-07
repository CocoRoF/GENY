"""Tests for the vision-capability heuristic."""

from __future__ import annotations

import pytest

from service.whiteboard.vision_capability import is_vision_capable


@pytest.mark.parametrize(
    "model",
    [
        "claude-opus-4-7",
        "claude-sonnet-4-6",
        "claude-haiku-4-5-20251001",
        "claude-3-5-sonnet",
        "gpt-4o",
        "gpt-4o-mini",
        "gpt-4-turbo",
        "gemini-1.5-pro",
        "gemini-2-flash",
    ],
)
def test_recognised_vision_models_are_capable(model: str) -> None:
    assert is_vision_capable(model) is True


@pytest.mark.parametrize(
    "model",
    [
        "gpt-3.5-turbo",
        "gpt-4-0314",
        "claude-instant-1",
        "claude-2.0",
        "llama-3-8b",
        "mistral-7b",
        "",
        None,
    ],
)
def test_unknown_models_are_not_capable(model: str) -> None:
    assert is_vision_capable(model) is False


def test_disable_env_overrides_known_vision_models(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("GENY_WHITEBOARD_DISABLE_VISION", "true")
    assert is_vision_capable("claude-opus-4-7") is False


def test_force_env_overrides_unknown_models(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("GENY_WHITEBOARD_FORCE_VISION", "1")
    assert is_vision_capable("totally-fictional-llm") is True


def test_disable_wins_over_force(monkeypatch: pytest.MonkeyPatch) -> None:
    # If both are set, the more conservative (disable) wins — image
    # content blocks pumped to a non-vision model are noisier than
    # missing images on a vision model.
    monkeypatch.setenv("GENY_WHITEBOARD_DISABLE_VISION", "true")
    monkeypatch.setenv("GENY_WHITEBOARD_FORCE_VISION", "true")
    assert is_vision_capable("claude-opus-4-7") is False


def test_custom_patterns_extend_recognition(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(
        "GENY_WHITEBOARD_VISION_CAPABLE_MODELS",
        "my-vision-llm,internal-omni",
    )
    assert is_vision_capable("my-vision-llm-v2") is True
    assert is_vision_capable("internal-omni-3b") is True
    assert is_vision_capable("regular-llm") is False
