"""BLAS threading — effect-proving test for a production wedge.

OpenBLAS sizes a worker pool to the host's cores. This process forks
constantly (the Claude Code CLI, docker exec, every subprocess tool), and the
pool does not survive a fork while the bookkeeping still claims it does. The
next matmul spin-waits on workers that never come: one core at 100%, inside a
call worth microseconds, forever — holding the memory engine's global lock.

That wedged production for 27 hours. Every agent turn timed out at 1800s and
`/health` answered "healthy" the whole time.

The fix is one environment variable, which makes it exactly the kind of thing
that gets dropped by a refactor with nothing to notice. It must be set BEFORE
numpy is imported anywhere, so the assertion is on main.py's source order —
importing main here would prove nothing about what runs first in production.
"""

from __future__ import annotations

import ast
from pathlib import Path

MAIN = Path(__file__).resolve().parents[1] / "main.py"

REQUIRED = {"OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "MKL_NUM_THREADS"}


def _pinning_line() -> int:
    """Line where the BLAS variables are pinned."""
    tree = ast.parse(MAIN.read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if not isinstance(node, ast.Constant) or not isinstance(node.value, str):
            continue
        if node.value in REQUIRED:
            return node.lineno
    return -1


def test_the_blas_variables_are_pinned_at_all():
    src = MAIN.read_text(encoding="utf-8")
    missing = [v for v in REQUIRED if v not in src]
    assert not missing, f"BLAS thread pinning lost: {missing}"


def test_they_are_pinned_before_anything_can_import_numpy():
    """A pin after the first heavy import is a pin that does nothing: numpy
    reads these once, at load, and the pool is already sized by then."""
    pin = _pinning_line()
    assert pin > 0

    tree = ast.parse(MAIN.read_text(encoding="utf-8"))
    early = [
        n for n in ast.walk(tree)
        if isinstance(n, (ast.Import, ast.ImportFrom)) and n.lineno < pin
    ]
    names = {
        (a.name.split(".")[0] if isinstance(n, ast.Import) else (n.module or "").split(".")[0])
        for n in early for a in n.names
    }
    # `os` is needed to set them; nothing else may run first.
    assert names <= {"os"}, f"imported before the BLAS pin: {sorted(names - {'os'})}"


def test_the_deployment_pins_them_too():
    """main.py is not the only way this image gets started. The compose file
    carries the same setting so a different entrypoint cannot lose it."""
    compose = MAIN.resolve().parents[1] / "docker-compose.prod.yml"
    text = compose.read_text(encoding="utf-8")
    for var in REQUIRED:
        assert f"{var}=1" in text, f"{var} not pinned in the production compose"


def test_the_pin_does_not_override_an_explicit_operator_setting():
    """`setdefault`, not assignment — an operator debugging a numeric problem
    must be able to raise it without editing code."""
    src = MAIN.read_text(encoding="utf-8")
    assert "os.environ.setdefault(" in src
