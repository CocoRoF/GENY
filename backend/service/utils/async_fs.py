"""Filesystem operations that are safe to call from async code.

WHY THIS MODULE EXISTS

``shutil.rmtree`` and friends are *synchronous*. Called from an ``async def``
they do not yield: the event loop stops until the last inode is unlinked, and
during that time the process serves nobody — no requests, no WebSocket frames,
no health probe. It is a full stall, not a slow request.

The scale is not hypothetical. Production session storage measured **16,487
files**; deleting one session's tree on the loop freezes the entire backend
for as long as that takes. We have already had the same failure through a
different door: a per-path pattern compile made one listing take 24 seconds
with the loop held.

These wrappers move the work to a thread so the loop keeps running. They are
deliberately thin — the point is that the async call sites stop being
synchronous, not that they gain new behaviour.
"""

from __future__ import annotations

import asyncio
import os
import shutil
from pathlib import Path
from typing import Any, Callable, Union

PathLike = Union[str, "os.PathLike[str]", Path]


async def rmtree_async(path: PathLike, *, ignore_errors: bool = False) -> None:
    """``shutil.rmtree`` without holding the event loop."""
    await asyncio.to_thread(shutil.rmtree, path, ignore_errors=ignore_errors)


async def copy2_async(src: PathLike, dst: PathLike) -> str:
    """``shutil.copy2`` without holding the event loop."""
    return await asyncio.to_thread(shutil.copy2, src, dst)


async def copytree_async(src: PathLike, dst: PathLike, **kwargs: Any) -> str:
    """``shutil.copytree`` without holding the event loop."""
    return await asyncio.to_thread(lambda: shutil.copytree(src, dst, **kwargs))


async def to_thread(fn: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
    """Run any blocking callable off the loop.

    For one-off blocking work that has no wrapper here — a walk, a large
    ``read_bytes``, a sync client call — rather than inventing a wrapper per
    call site.
    """
    if kwargs:
        return await asyncio.to_thread(lambda: fn(*args, **kwargs))
    return await asyncio.to_thread(fn, *args)
