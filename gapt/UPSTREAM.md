# Vendored: geny-adapted-project-toolkit (GAPT)

This directory is a **vendored copy** (not a git submodule) of GAPT, the
self-hosted sandbox/project/devops platform that Geny delegates all
project / workspace / sandbox / deploy logic to.

- **Upstream:** https://github.com/CocoRoF/geny-adapted-project-toolkit
- **Vendored commit:** `d15a592891e4460b1b9171c1bf62e6d884f4d21f`
- **Vendored on:** 2026-06-22

## Why vendored (not a submodule)

Geny ships GAPT as a sub-repo so the whole stack builds and deploys from one
checkout (see `docs/analysis/gapt-integration-plan.md`). A copy (rather than a
submodule) keeps clones/builds/CI simple at the cost of manual re-sync.

## How to re-sync from upstream

```bash
# from the geny-workspace root, with the upstream repo checked out alongside
rsync -a --delete \
  --exclude='.git/' --exclude='.venv/' --exclude='node_modules/' \
  --exclude='__pycache__/' --exclude='*.pyc' --exclude='.pytest_cache/' \
  --exclude='.ruff_cache/' --exclude='.mypy_cache/' --exclude='.gapt/' \
  --exclude='dist/' --exclude='build/' --exclude='*.egg-info/' \
  --exclude='htmlcov/' --exclude='.coverage' --exclude='web/dist/' \
  geny-adapted-project-toolkit/ Geny/gapt/
# then update the "Vendored commit" + date above to the new upstream HEAD.
```

## Excluded from the vendor

`.git/`, virtualenvs, `node_modules/`, build artifacts, caches, and **`.gapt/`
(local runtime state — vault sqlite / secrets)** are intentionally not copied.

## Integration seam (Geny ⇄ GAPT)

- The sandbox-**execution** primitive lives in `geny-executor`
  (`ContainerCLIRunner` + `SandboxHandle`, ≥2.21.1). GAPT and Geny both use it.
- GAPT owns the **platform** (Postgres-backed project/workspace/sandbox model,
  container lifecycle, git/fs/terminal/services/preview/deploy).
- Geny **delegates** to GAPT over its REST API (`/_gapt/api/**`) via
  `backend/service/gapt/` (see the integration plan).
