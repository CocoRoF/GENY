"""Does the agent know where it stands? — effect-proving tests.

The user's requirement was explicit: the layout has to be something "Agent도
인지할 수 있는 방식". An agent's space lives inside GenyCloud now, which makes
two facts non-discoverable from the filesystem alone:

  · writes here land on the user's PCs and beside the other agents' work —
    so deleting or overwriting is not a private act;
  · the siblings exist at all. An agent that cannot name `gapt/` or another
    agent's space will ask the user to re-upload what is already in the tree.

The old probe looked for a `workspace/cloud` symlink. That link is gone, so
the check that matters is that the section still fires for a space that IS
in the cloud — a silent regression here reads exactly like a working prompt.
"""

from __future__ import annotations

import pytest

from service.cloud import store
from service.prompt.sections import build_agent_prompt


@pytest.fixture
def adopted(tmp_path, monkeypatch):
    monkeypatch.setenv("GENY_CLOUD_ROOT", str(tmp_path / "_cloud"))
    storage = tmp_path / "sessions" / "sid-1"
    (storage / "workspace").mkdir(parents=True)
    store.adopt_agent_space("hr", str(storage), "sid-1")
    return str(storage)


def test_an_adopted_agent_is_told_it_is_in_the_shared_cloud(adopted):
    prompt = build_agent_prompt(storage_path=adopted)
    assert "GenyCloud" in prompt, "the agent was never told the space is shared"
    assert "agents/sid-1" in prompt, "the agent cannot say where it stands"


def test_it_is_told_what_the_siblings_are(adopted):
    """Naming them is what turns "there is a cloud" into something usable."""
    prompt = build_agent_prompt(storage_path=adopted)
    for landmark in ("agents/<id>/", "gapt/", ".gapt/"):
        assert landmark in prompt, f"{landmark} is unnamed — invisible in practice"


def test_it_is_told_the_consequence_of_writing_there(adopted):
    prompt = build_agent_prompt(storage_path=adopted)
    assert "PC" in prompt and ("mirror" in prompt or "appears" in prompt), (
        "shared-ness stated without its consequence is decoration"
    )


def test_scratch_is_marked_as_the_one_thing_that_stays_local(adopted):
    prompt = build_agent_prompt(storage_path=adopted)
    assert "does NOT mirror" in prompt


def test_a_session_outside_the_cloud_says_nothing_about_it(tmp_path, monkeypatch):
    """A non-adopted session must not claim a sharing property it lacks."""
    monkeypatch.setenv("GENY_CLOUD_ROOT", str(tmp_path / "_cloud"))
    storage = tmp_path / "loose"
    (storage / "workspace").mkdir(parents=True)

    prompt = build_agent_prompt(storage_path=str(storage))

    assert "GenyCloud" not in prompt


def test_the_manifest_survives_a_broken_cloud_lookup(adopted, monkeypatch):
    """The prompt is the session's whole contract with the model — a cloud
    module that raises must cost the extra sentence, never the prompt."""
    import service.cloud as cloud_mod

    def _boom(*_a, **_kw):
        raise RuntimeError("cloud unavailable")

    monkeypatch.setattr(cloud_mod, "owning_storage", _boom)
    prompt = build_agent_prompt(storage_path=adopted)

    assert "Files workspace" in prompt
