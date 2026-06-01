"""Blog Agent integration package.

외부 블로그(예: hrletsgo.me) 의 AI Agent 에 작업을 위임하기 위한
HTTP 클라이언트 + 비동기 task registry + 결과 delivery 헬퍼.

VTuber 가 ``blog_agent_*`` 도구를 통해 사용. 자세한 설계는
``BLOG_AGENT_DELEGATION_PLAN.md`` 참조.

Public surface:

    AsyncBlogAgentClient  — HTTP/SSE 클라이언트 (httpx 기반)
    BlogTaskRegistry      — 위임 task 의 in-memory 진행 상태
    deliver_external_result — turn_complete 시 호출자 inbox 에 결과 deliver
    BlogAgent*Error       — 예외 계층

Phase 별 의존:
    Phase 1: client + registry + delivery
    Phase 2: InteractionEvent 분류 (geny_tools 측 변경)
    Phase 3: blog_agent_*  도구 (현재 ``service.custom_tools.sample_sources.blog/*.py``
             의 python_inline DB 샘플) 가 이 패키지를 import — registry,
             client, delivery 의 단일 SOT.
"""

from service.blog_agent.exceptions import (
    BlogAgentCancelled,
    BlogAgentError,
    BlogAgentHTTPError,
    BlogAgentNotConfigured,
    BlogAgentTransportError,
)
from service.blog_agent.client import AsyncBlogAgentClient
from service.blog_agent.events import Frame, parse_sse_block
from service.blog_agent.registry import (
    BlogTaskRegistry,
    BlogTaskState,
    FrameSummary,
    TaskStatus,
    get_blog_task_registry,
)

__all__ = [
    "AsyncBlogAgentClient",
    "BlogAgentCancelled",
    "BlogAgentError",
    "BlogAgentHTTPError",
    "BlogAgentNotConfigured",
    "BlogAgentTransportError",
    "BlogTaskRegistry",
    "BlogTaskState",
    "Frame",
    "FrameSummary",
    "TaskStatus",
    "get_blog_task_registry",
    "parse_sse_block",
]
