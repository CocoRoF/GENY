#!/usr/bin/env python3
"""Fail the build on defects that only detonate in production.

WHY THIS EXISTS

A missing declaration (``_prune_tasks``) raised NameError on every
screen-observation upload for twelve hours. Nothing caught it: the module
imported, the syntax was valid, and the line only ran on a live request. The
lesson is not "that one bug" — it is that this whole family is invisible to
import, to type checkers, and to any test that does not walk the exact path,
yet is trivially visible to a parser.

So each check below is a defect class we have actually shipped, phrased as a
question a syntax tree can answer:

  undefined-name     a name that does not exist -> NameError on that line
  missing-await      an ``async def`` called without await -> body never runs
  task-no-ref        a detached task with no strong reference -> can be
                     garbage-collected mid-run, and its failure is silent
  blocking-in-async  synchronous I/O on the event loop -> the entire process
                     stops serving for the duration, not just that request

Deliberately narrow. A broad style linter over 170k lines produces noise, gets
ignored, and then catches nothing at all. Everything here is a real defect
with a production incident behind it.

Usage:  python scripts/check_runtime_hazards.py [root]     (default: cwd)
"""

from __future__ import annotations

import ast
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any, Dict, List, Set, Tuple

SKIP_DIRS = {".venv", "__pycache__", "node_modules", ".git", "tests", "migrations"}

#: Synchronous calls that stop the event loop. Wrap with
#: ``service.utils.async_fs`` (or ``asyncio.to_thread``) at async call sites.
BLOCKING: Set[str] = {
    "time.sleep",
    "requests.get", "requests.post", "requests.put", "requests.delete",
    "requests.patch", "requests.head", "requests.request",
    "subprocess.run", "subprocess.call", "subprocess.check_output",
    "subprocess.check_call",
    "os.system",
    "shutil.rmtree", "shutil.copytree", "shutil.copy", "shutil.copy2",
    "shutil.move",
    "urllib.request.urlopen",
}

Finding = Tuple[str, int, str, str]  # (file, line, code, message)


def dotted(node: ast.AST) -> str:
    parts: List[str] = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if isinstance(node, ast.Name):
        parts.append(node.id)
    return ".".join(reversed(parts))


class ModuleAudit(ast.NodeVisitor):
    """One module. Two passes: learn the module's functions, then judge calls."""

    def __init__(self, path: Path, rel: str) -> None:
        self.rel = rel
        self.findings: List[Finding] = []
        self.async_fns: Set[str] = set()
        #: sync function name -> blocking calls in its body. Used to catch the
        #: TRANSITIVE case: an async handler calling a sync helper that
        #: blocks. Direct-call checking alone missed a real one of these.
        self.sync_blocking: Dict[str, List[Tuple[int, str]]] = defaultdict(list)
        self.fn_stack: List[Tuple[str, bool]] = []
        #: Calls inside a lambda do not run where the lambda is written — it is
        #: usually being handed to ``to_thread`` precisely to get OFF the loop.
        self.lambda_depth = 0

    # ---- pass 1 ----
    def learn(self, tree: ast.AST) -> None:
        for node in ast.walk(tree):
            if isinstance(node, ast.AsyncFunctionDef):
                self.async_fns.add(node.name)
            elif isinstance(node, ast.FunctionDef):
                for inner in ast.walk(node):
                    if isinstance(inner, ast.Call) and dotted(inner.func) in BLOCKING:
                        if not self._inside_lambda(node, inner):
                            self.sync_blocking[node.name].append(
                                (inner.lineno, dotted(inner.func))
                            )

    @staticmethod
    def _inside_lambda(scope: ast.AST, target: ast.AST) -> bool:
        for node in ast.walk(scope):
            if isinstance(node, ast.Lambda):
                if any(child is target for child in ast.walk(node)):
                    return True
        return False

    # ---- pass 2 ----
    def visit_Lambda(self, node: ast.Lambda) -> None:
        self.lambda_depth += 1
        self.generic_visit(node)
        self.lambda_depth -= 1

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        self.fn_stack.append((node.name, False))
        self.generic_visit(node)
        self.fn_stack.pop()

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        self.fn_stack.append((node.name, True))
        self.generic_visit(node)
        self.fn_stack.pop()

    def visit_Expr(self, node: ast.Expr) -> None:
        value = node.value
        if isinstance(value, ast.Call):
            fn = dotted(value.func)
            if fn.endswith("create_task") or fn.endswith("ensure_future"):
                self.findings.append((
                    self.rel, node.lineno, "task-no-ref",
                    f"{fn}(...) result discarded — the loop keeps only a weak "
                    "reference, so this task can be collected mid-run and its "
                    "failure is never logged. Use "
                    "service.utils.background.spawn_background().",
                ))
            short = fn.split(".")[-1]
            if short in self.async_fns and not isinstance(value.func, ast.Attribute):
                self.findings.append((
                    self.rel, node.lineno, "missing-await",
                    f"{fn}() is `async def` but not awaited — its body never runs.",
                ))
        self.generic_visit(node)

    def visit_Call(self, node: ast.Call) -> None:
        if self.lambda_depth == 0 and any(is_async for _, is_async in self.fn_stack):
            fn = dotted(node.func)
            if fn in BLOCKING:
                self.findings.append((
                    self.rel, node.lineno, "blocking-in-async",
                    f"{fn}() is synchronous — on the event loop it stalls the "
                    "WHOLE process, not just this request. Use "
                    "service.utils.async_fs (or asyncio.to_thread).",
                ))
            # transitive: async -> sync helper in this module that blocks
            bare = fn.split(".")[-1]
            if fn == bare and bare in self.sync_blocking:
                for ln, blocked in self.sync_blocking[bare]:
                    self.findings.append((
                        self.rel, node.lineno, "blocking-in-async",
                        f"{bare}() is sync and calls {blocked}() at line {ln} — "
                        "calling it from async code blocks the event loop.",
                    ))
        self.generic_visit(node)


def undefined_names(root: Path) -> List[Finding]:
    """Delegate to pyflakes, keeping only the undefined-name verdicts."""
    try:
        from pyflakes.api import checkPath
        from pyflakes.reporter import Reporter
    except ImportError:
        print("pyflakes not installed — undefined-name check SKIPPED", file=sys.stderr)
        return []

    import io

    out, err = io.StringIO(), io.StringIO()
    reporter = Reporter(out, err)
    for path in sorted(root.rglob("*.py")):
        if any(part in SKIP_DIRS for part in path.parts):
            continue
        checkPath(str(path), reporter)

    findings: List[Finding] = []
    for line in out.getvalue().splitlines():
        if "undefined name" not in line:
            continue
        parts = line.split(":", 3)
        if len(parts) >= 4:
            try:
                rel = str(Path(parts[0]).relative_to(root))
            except ValueError:
                rel = parts[0]
            findings.append((rel, int(parts[1]), "undefined-name", parts[3].strip()))
    return findings


def call_arity(root: Path) -> List[Finding]:
    """Calls that cannot possibly succeed — wrong arity, missing required
    keyword-only argument.

    This is the same failure shape as an undefined name: it imports, it
    compiles, tests that never walk the line stay green, and it detonates on
    the first live request. `spawn_background(coro)` — with `name` declared
    keyword-only and required — shipped exactly this way and took the rest of
    session creation down with it, because the TypeError propagated past an
    `except RuntimeError`.

    Scoped to be quiet rather than clever: only functions defined EXACTLY ONCE
    across the tree, called by bare name, in a module that imports that name.
    A duplicate name, a method, an alias or a decorated function is skipped —
    a false positive here costs more than the miss.
    """
    defs: Dict[str, List[Any]] = defaultdict(list)
    trees: List[tuple] = []
    for path in sorted(root.rglob("*.py")):
        if any(part in SKIP_DIRS for part in path.parts):
            continue
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        except SyntaxError:
            continue
        trees.append((path, tree))
        for node in ast.iter_child_nodes(tree):  # module level only, not methods
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                defs[node.name].append(node)

    unique = {
        name: nodes[0]
        for name, nodes in defs.items()
        if len(nodes) == 1 and not nodes[0].decorator_list
    }

    findings: List[Finding] = []
    for path, tree in trees:
        rel = str(path.relative_to(root))
        imported = {
            alias.asname or alias.name
            for node in ast.walk(tree)
            if isinstance(node, ast.ImportFrom)
            for alias in node.names
        }
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Name):
                continue
            fn = unique.get(node.func.id)
            if fn is None or node.func.id not in imported:
                continue
            if any(isinstance(a, ast.Starred) for a in node.args) or any(
                k.arg is None for k in node.keywords
            ):
                continue  # *args / **kwargs — arity is not statically known
            given = {k.arg for k in node.keywords}
            required_kw = {
                a.arg
                for a, d in zip(fn.args.kwonlyargs, fn.args.kw_defaults)
                if d is None
            }
            missing = sorted(required_kw - given)
            if missing:
                findings.append((
                    rel, node.lineno, "call-missing-kwarg",
                    f"{node.func.id}() missing required keyword-only "
                    f"{', '.join(missing)}",
                ))
                continue
            pos = fn.args.posonlyargs + fn.args.args
            n_required = len(pos) - len(fn.args.defaults)
            supplied = len(node.args) + len(
                [k for k in node.keywords if k.arg in {a.arg for a in pos}]
            )
            if not fn.args.vararg and len(node.args) > len(pos):
                findings.append((
                    rel, node.lineno, "call-too-many-args",
                    f"{node.func.id}() takes {len(pos)}, got {len(node.args)}",
                ))
            elif supplied < n_required:
                findings.append((
                    rel, node.lineno, "call-too-few-args",
                    f"{node.func.id}() needs {n_required}, got {supplied}",
                ))
    return findings


def main() -> int:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
    findings: List[Finding] = []

    for path in sorted(root.rglob("*.py")):
        if any(part in SKIP_DIRS for part in path.parts):
            continue
        rel = str(path.relative_to(root))
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        except SyntaxError as exc:
            findings.append((rel, exc.lineno or 0, "syntax", str(exc.msg)))
            continue
        audit = ModuleAudit(path, rel)
        audit.learn(tree)
        audit.visit(tree)
        findings.extend(audit.findings)

    findings.extend(undefined_names(root))
    findings.extend(call_arity(root))

    if not findings:
        print("OK — no runtime hazards found.")
        return 0

    by_code: Dict[str, List[Finding]] = defaultdict(list)
    for finding in findings:
        by_code[finding[2]].append(finding)

    for code in sorted(by_code):
        items = by_code[code]
        print(f"\n{code}: {len(items)}")
        for rel, line, _, message in sorted(items):
            print(f"  {rel}:{line}  {message}")

    print(f"\nFAILED — {len(findings)} runtime hazard(s).")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
