"""Korean descriptions for the Geny tool catalog (`/api/tools/catalog/external`).

The English descriptions live on the tool classes themselves
(`tool.description`) — they're the ground truth used by the LLM at
runtime. This module mirrors them in Korean so the picker UI can
localise without touching the tool sources.

Keys here are the canonical tool names (matching `tool.name`). Any
tool not listed here falls back to the English description on its
class. Add new entries when introducing tools.
"""

from __future__ import annotations

TOOL_DESCRIPTIONS_KO: dict[str, str] = {
    # ── Memory tools (memory_tools.py) ──
    "memory_write": (
        "새 메모리 노트를 작성합니다. 중요한 정보, 결정, 지식, "
        "또는 나중에 기억해야 할 내용을 저장할 때 사용하세요."
    ),
    "memory_read": (
        "특정 메모리 노트를 파일명으로 읽어옵니다. 메타데이터를 "
        "포함한 전체 본문을 반환합니다."
    ),
    "memory_search": (
        "관련된 메모리를 검색합니다. 텍스트 매칭과 시맨틱 벡터 검색을 "
        "함께 사용해 가장 적합한 결과를 찾습니다."
    ),
    "memory_list": (
        "모든 메모리 노트를 나열합니다. 카테고리(주제, 결정, 인사이트, "
        "사람 등)나 태그로 필터링할 수 있습니다."
    ),
    "memory_update": (
        "기존 메모리 노트를 업데이트합니다. 본문, 태그, 중요도 등을 "
        "변경할 수 있습니다."
    ),
    "memory_delete": (
        "메모리 노트를 영구적으로 삭제합니다. 주의 — 노트가 "
        "메모리 시스템에서 완전히 제거됩니다."
    ),
    "memory_link": (
        "두 메모리 노트 간 링크(위키링크 형태)를 생성합니다. 관련 "
        "지식을 연결된 그래프로 묶을 때 유용합니다."
    ),
    # ── Knowledge tools (knowledge_tools.py) ──
    "knowledge_search": (
        "큐레이션된 지식 베이스에서 관련 노트를 검색합니다. 사용자의 "
        "개인 vault에서 정제된 품질 검증 노트들이며, 가장 관련성 높은 "
        "결과를 반환합니다."
    ),
    "knowledge_read": (
        "특정 큐레이션 지식 노트를 파일명으로 읽어옵니다. 메타데이터와 "
        "본문을 포함한 전체 내용을 반환합니다."
    ),
    "knowledge_list": (
        "큐레이션된 지식 노트를 나열합니다. 카테고리나 태그로 "
        "필터링 가능 — 사용자의 검증된 지식 베이스를 둘러볼 때 유용."
    ),
    "knowledge_promote": (
        "중요한 세션 메모리 노트를 사용자의 큐레이션 지식 베이스로 "
        "승격합니다. 세션 간 영속화되어 향후 에이전트가 접근 가능."
    ),
    "opsidian_browse": (
        "사용자의 개인 Opsidian 지식 vault를 둘러봅니다. 사용 가능한 "
        "노트를 제목, 카테고리, 태그와 함께 나열 — 어떤 지식이 있는지 "
        "발견할 때 사용."
    ),
    "opsidian_read": (
        "사용자의 Opsidian vault에서 특정 노트를 읽어옵니다. 사용자의 "
        "개인 지식, 메모, 통찰에 접근할 수 있습니다."
    ),
    # ── Session / Room / Messaging tools (geny_tools.py) ──
    "session_list": (
        "현재 회사의 모든 팀원(에이전트 세션)을 나열합니다. 각 세션은 "
        "역할, 모델, 상태 등의 정보를 포함합니다."
    ),
    "session_info": (
        "특정 팀원(에이전트 세션)의 상세 프로필을 이름이나 ID로 "
        "가져옵니다. 모델, 시스템 프롬프트, 활성 도구 등을 반환."
    ),
    "session_create": (
        "새 팀원을 영입합니다 — 새 에이전트 세션을 생성합니다. "
        "session_name만 필수이며 나머지는 선택입니다."
    ),
    "room_list": (
        "현재 활성 채팅방을 나열합니다. 멤버 수, 마지막 활동, 주제 등이 "
        "포함됩니다."
    ),
    "room_create": (
        "새 채팅방을 생성합니다. 멤버를 초대하고 주제를 설정해 그룹 "
        "협업을 시작할 수 있습니다."
    ),
    "room_info": (
        "특정 채팅방의 상세 정보(멤버, 주제, 최근 활동)를 가져옵니다."
    ),
    "room_add_members": (
        "기존 채팅방에 새 멤버를 추가합니다. 한 번에 여러 명을 초대할 "
        "수 있습니다."
    ),
    "send_room_message": (
        "채팅방에 메시지를 보냅니다. 같은 방의 모든 멤버가 메시지를 "
        "받습니다."
    ),
    "send_direct_message_external": (
        "바인딩된 카운터파트가 아닌 다른 세션(외부)에 다이렉트 "
        "메시지(DM)를 보냅니다."
    ),
    "send_direct_message_internal": (
        "바인딩된 카운터파트 에이전트에게 다이렉트 메시지를 보냅니다. "
        "1:1 협업이 필요할 때 사용."
    ),
    "read_room_messages": (
        "특정 채팅방의 최근 메시지 기록을 읽습니다. 한도와 시작 시각을 "
        "지정해 페이징할 수 있습니다."
    ),
    "read_inbox": (
        "다른 팀원으로부터 받은 다이렉트 메시지(받은 편지함)를 "
        "확인합니다. 가장 최근 DM부터 반환됩니다."
    ),
    # ── Game / Creature interaction tools (service/game/tools/) ──
    "feed": (
        "크리처에게 먹이를 줍니다. 플레이어가 무언가 먹을 것을 주거나 "
        "보살피는 액션을 보냈을 때 사용합니다."
    ),
    "gift": (
        "크리처에게 선물을 줍니다. ``flower``는 단순 제스처, "
        "``toy``는 놀이용 아이템처럼 종류별로 다른 반응을 유도합니다."
    ),
    "play": (
        "크리처와 물리적 또는 상호작용 놀이를 합니다. ``kind``를 골라 "
        "원하는 놀이 분위기에 맞춥니다."
    ),
    "talk": (
        "대화 비트를 표시합니다. 메타 액션 전용 — 일반 대화에는 "
        "사용하지 마세요."
    ),
    # ── Custom tools — Browser (browser_tools.py) ──
    "browser_navigate": (
        "실제 브라우저로 URL에 접속해 렌더링된 페이지 콘텐츠를 "
        "반환합니다. JavaScript도 실행됩니다."
    ),
    "browser_click": (
        "현재 브라우저 페이지의 요소를 CSS 셀렉터로 클릭합니다. "
        "browser_navigate 후 상호작용에 사용."
    ),
    "browser_fill": (
        "현재 페이지의 폼 필드(input, textarea)에 텍스트를 입력합니다. "
        "CSS 셀렉터로 필드를 지정합니다."
    ),
    "browser_evaluate": (
        "현재 브라우저 페이지에서 JavaScript를 실행하고 결과를 "
        "반환합니다. 정밀한 데이터 추출에 활용."
    ),
    "browser_screenshot": (
        "현재 브라우저 페이지의 스크린샷을 캡처합니다. PNG 형식으로 "
        "반환됩니다."
    ),
    "browser_page_info": (
        "현재 브라우저 페이지의 URL, 제목, 상호작용 가능한 요소 "
        "(링크, 버튼 등) 목록을 가져옵니다."
    ),
    "browser_close": (
        "브라우저를 닫고 모든 리소스를 해제합니다. 쿠키, 세션, 페이지 "
        "상태가 모두 초기화됩니다."
    ),
    # ── Custom tools — Web fetch & search (web_fetch_tools.py / web_search_tools.py) ──
    "web_fetch": (
        "단일 URL에서 콘텐츠를 가져옵니다. JavaScript 렌더링 없이 "
        "HTTP GET으로 빠르게 가져오는 모드 — 정적 콘텐츠에 적합."
    ),
    "web_fetch_multiple": (
        "여러 URL에서 콘텐츠를 병렬로 가져옵니다. 대량 페치에 사용 — "
        "rate limit과 timeout이 적용됩니다."
    ),
    "web_search": (
        "웹 검색을 실행합니다. 검색 엔진이 반환한 결과 목록(제목, URL, "
        "스니펫)을 반환합니다."
    ),
    "news_search": (
        "뉴스 기사를 검색합니다. 일반 웹 검색과 달리 시간 가중치가 "
        "걸려 최근 기사가 우선합니다."
    ),
}
