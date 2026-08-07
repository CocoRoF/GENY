"""Storage listing containment — effect-proving tests.

`subpath` arrives from a query string and a workspace can hold symlinks
(agents write there; the server itself plants one). The listing joined the two
and walked whatever came out, so a symlink pointed anywhere made this endpoint
enumerate that directory. Verified against production before the fix: a link
to /etc listed 498 entries out of the backend container.

Reading a file's bytes and every write path already resolved and checked. Only
the listing did not — which is the worst place to miss it, because it is the
one endpoint the UI polls.

The cloud is the single legitimate way out, and it is passed in explicitly by
a caller that has already authorised that scope. It is never inferred from the
tree, so a symlink NAMED cloud does not become one.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from service.utils.file_storage import list_storage_files


@pytest.fixture
def scope(tmp_path):
    ws = tmp_path / "scope" / "workspace"
    ws.mkdir(parents=True)
    (ws / "mine.txt").write_text("inside", encoding="utf-8")
    (ws / "sub").mkdir()
    (ws / "sub" / "nested.txt").write_text("also inside", encoding="utf-8")
    return ws


def _names(rows):
    return {r["name"] for r in rows}


# ── what must still work ────────────────────────────────────────────

def test_ordinary_listing_is_unaffected(scope):
    assert "mine.txt" in _names(list_storage_files(str(scope)))


def test_subdirectory_listing_is_unaffected(scope):
    assert _names(list_storage_files(str(scope), subpath="sub")) == {"nested.txt"}


# ── what must not ───────────────────────────────────────────────────

def test_a_symlink_out_of_the_scope_lists_nothing(scope, tmp_path):
    """THE defect. A link planted in the workspace made the listing walk
    whatever it pointed at."""
    secret = tmp_path / "elsewhere"
    secret.mkdir()
    (secret / "passwd").write_text("root:x:0:0", encoding="utf-8")
    os.symlink(secret, scope / "escape")

    assert list_storage_files(str(scope), subpath="escape") == []


def test_dotdot_traversal_lists_nothing(scope):
    assert list_storage_files(str(scope), subpath="../..") == []
    assert list_storage_files(str(scope), subpath="sub/../../..") == []


def test_an_absolute_subpath_cannot_redirect_the_listing(scope, tmp_path):
    """`Path(a) / "/etc"` yields "/etc" — joining an absolute path DISCARDS
    the left side, so this is a redirect rather than a traversal."""
    other = tmp_path / "other"
    other.mkdir()
    (other / "x").write_text("x", encoding="utf-8")

    assert list_storage_files(str(scope), subpath=str(other)) == []


# ── the one sanctioned way out ──────────────────────────────────────

def test_the_cloud_link_is_followed_when_the_caller_passes_it(scope, tmp_path):
    cloud = tmp_path / "cloud" / "workspace"
    cloud.mkdir(parents=True)
    (cloud / "shared.txt").write_text("in the cloud", encoding="utf-8")
    os.symlink(cloud, scope / "cloud")

    rows = list_storage_files(str(scope), subpath="cloud", extra_roots=[str(cloud)])
    assert _names(rows) == {"shared.txt"}


def test_the_cloud_link_is_refused_when_it_is_not_passed(scope, tmp_path):
    """A disconnected agent must not reach the cloud just because the link is
    still on disk — the authorisation lives with the caller, not the tree."""
    cloud = tmp_path / "cloud" / "workspace"
    cloud.mkdir(parents=True)
    (cloud / "shared.txt").write_text("in the cloud", encoding="utf-8")
    os.symlink(cloud, scope / "cloud")

    assert list_storage_files(str(scope), subpath="cloud") == []


def test_a_symlink_merely_named_cloud_is_not_trusted(scope, tmp_path):
    """The sanctioned root is a PATH the caller supplies, not a name in the
    tree — otherwise planting `cloud -> /etc` would defeat the whole check."""
    real_cloud = tmp_path / "cloud" / "workspace"
    real_cloud.mkdir(parents=True)
    impostor = tmp_path / "not-the-cloud"
    impostor.mkdir()
    (impostor / "loot.txt").write_text("nope", encoding="utf-8")
    os.symlink(impostor, scope / "cloud")

    rows = list_storage_files(str(scope), subpath="cloud", extra_roots=[str(real_cloud)])
    assert rows == []
