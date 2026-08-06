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
from typing import Dict, List, Set, Tuple

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
