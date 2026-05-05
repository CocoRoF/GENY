# P0 — Composite/Ephemeral `set_hooks` + STM 단일 경로 복구

> 작성: 2026-05-05 · 우선순위: 시급 (기능 멈춤).
> 진단 근거: `docs/analysis/MEMORY_REGRESSION_AFTER_PATH_A.md` §1.

---

## 0. 목표 한 줄

**일반 user/assistant 채팅이 STM jsonl 에 1줄씩 정상 기록되고 → `after_record_turn` hook 이 ConversationArchiver / DmArchiver 를 자동 트리거 → `memory/conversations/` + `memory/dms/` 폴더가 정상 생성되도록** 두 회귀 (composite set_hooks 미구현 + MEMORY_PROVIDER_ATTACH 기본 false) 를 동시에 fix.

---

## 1. 책임 분담 (executor vs Geny)

### executor (geny-executor 측 책임 — "강력한 일반 인터페이스")

- **모든 `MemoryProvider` 구현체에 `set_hooks` 일관 제공** (file, ephemeral, sql, composite).
  - `set_hooks(hooks: MemoryHooks)` 는 protocol 자체에 추가하거나 mixin/abstract 가 default 구현 제공.
  - composite 는 자기 hook 보유 + 모든 scope_provider 의 set_hooks 에 forward.
- **`MemoryHooks.after_record_turn`** 은 STMHandle.append 가 끝난 직후 fire 하는 보장된 콜백 채널 (이미 1.17.0 EXEC-2 로 구현된 contract). 이 contract 가 모든 provider 에서 균일해야 host 가 신뢰할 수 있음.
- **stage 18 의 `_drive_provider` 활성/비활성** 은 host 결정사항이지만, 비활성 상태에서도 `manager.record_message` 같은 Geny 측 직접 호출 path 는 호출만 하면 STMHandle.append → after_record_turn 이 발사되어야 함 (이미 그렇게 동작; 회귀 A 만 fix 되면 충분).

### Geny (host 측 책임 — "구체적 비즈니스 확장")

- **모든 user/assistant turn 이 STM 에 도달하도록 보장** — 운영 환경에서 stage 18 `_drive_provider` 가 비활성이면 Geny 가 그 책임을 짊어짐.
- **구체적 환경 기본값 결정** — docker-compose 의 `MEMORY_PROVIDER_ATTACH` default 를 `true` 로 변경. path-A 마이그레이션의 단일 STM 경로 가정과 일치.
- ConversationArchiver / DmArchiver / 기타 archiver 는 hook 콜백 안에서 동작 (이미 GENY-5/6 으로 구현됨). hook 이 fire 만 되면 자동 동작.

---

## 2. 회귀 A — `CompositeMemoryProvider.set_hooks` 구현 (executor 측)

### 2.1 현재 상태

- [`geny-executor/src/geny_executor/memory/providers/file/provider.py:109`](https://github.com/CocoRoF/geny-executor/blob/main/src/geny_executor/memory/providers/file/provider.py#L109) — `FileMemoryProvider.set_hooks` 구현됨.
- `geny-executor/src/geny_executor/memory/composite/provider.py` — `set_hooks` 메서드 없음.
- `geny-executor/src/geny_executor/memory/providers/ephemeral.py` — 없음.
- `geny-executor/src/geny_executor/memory/providers/sql/provider.py` — 없음.

Geny 의 [`AgentSession._install_memory_hooks`](backend/service/executor/agent_session.py#L1071) 가 `hasattr(provider, "set_hooks")` 체크 후 silent skip → 모든 composite 사용 환경에서 hook 등록 0회.

### 2.2 EXEC-A1 — `MemoryProvider` Protocol 에 `set_hooks` 추가

**대상 파일**: `geny-executor/src/geny_executor/memory/provider.py`

`MemoryProvider` Protocol 에 추가:
```python
def set_hooks(self, hooks: MemoryHooks) -> None: ...
```

또는 default no-op 으로 mixin 제공 (구현 강제 부담 없게):
```python
class _MemoryProviderHookMixin:
    """Default no-op `set_hooks` so every provider satisfies the
    Protocol surface. Concrete providers override to forward to
    their store layers (FileMemoryProvider already does this)."""

    def set_hooks(self, hooks: "MemoryHooks") -> None:
        return None
```

설계 결정: **Protocol 에 추가 + 모든 구현체 명시 구현**. mixin 디폴트는 silent fallback 위험 있음 (hooks 가 안 fire 되는 시나리오 재발 가능).

### 2.3 EXEC-A2 — `CompositeMemoryProvider.set_hooks` 구현 (forward to delegates)

**대상 파일**: `geny-executor/src/geny_executor/memory/composite/provider.py`

```python
def set_hooks(self, hooks: MemoryHooks) -> None:
    """Forward hooks to every distinct scope provider.

    The composite itself doesn't own STM/Notes — it routes layer
    calls to the underlying scope providers (session, user_curated,
    global). Hooks must reach the actual store layer where
    after_record_turn / after_note_write fire, so we install on
    every distinct delegate.
    """
    self._hooks = hooks
    for delegate in self._routing.distinct_providers():
        if hasattr(delegate, "set_hooks"):
            delegate.set_hooks(hooks)
```

### 2.4 EXEC-A3 — `EphemeralMemoryProvider.set_hooks` + `SqlMemoryProvider.set_hooks`

**대상**: `providers/ephemeral.py`, `providers/sql/provider.py`

ephemeral 은 unit test 용. file 과 동일 패턴 (`_stm._hooks = hooks`, `_notes._hooks = hooks`) 로 구현. sql 은 hook trigger 가 미구현이라면 일단 attribute 만 보유하고 후속 PR 에서 fire 추가.

### 2.5 테스트 (executor 측)

- `tests/unit/test_memory_hooks_after_callbacks.py` 확장:
  - `CompositeMemoryProvider(...)` 빌드 → `set_hooks` 호출 → underlying file provider 의 `_hooks` 가 같은 객체인지 검증.
  - composite STMHandle.append → after_record_turn callback fire 확인.
  - ephemeral provider 동일 검증.

### 2.6 release

- `geny-executor 1.17.2` patch release.
- Geny 측 PR 의 `requirements.txt` / `pyproject.toml` 을 `>=1.17.2,<2.0.0` 으로 bump.

---

## 3. 회귀 B — `MEMORY_PROVIDER_ATTACH` 기본 true 화 (Geny 측)

### 3.1 현재 상태

- [`docker-compose.yml:86`](docker-compose.yml#L86): `MEMORY_PROVIDER_ATTACH=${MEMORY_PROVIDER_ATTACH:-false}` (모든 compose 파일 동일).
- [`backend/service/memory_provider/config.py:213`](backend/service/memory_provider/config.py#L213): `is_attach_enabled()` 가 false 반환.
- [`backend/service/executor/agent_session_manager.py:841`](backend/service/executor/agent_session_manager.py#L841): `is_attach_enabled()` False → `attach_to_pipeline` skip → stage 18 `_provider = None` → `_drive_provider` dead.
- → user/assistant 메시지가 STM 에 도달 못함.

### 3.2 GENY-B1 — docker-compose 디폴트 변경

**대상 파일**: `docker-compose.yml`, `docker-compose.dev.yml`, `docker-compose.dev-core.yml`, `docker-compose.prod.yml`, `docker-compose.prod-core.yml`

```yaml
- MEMORY_PROVIDER_ATTACH=${MEMORY_PROVIDER_ATTACH:-true}
```

### 3.3 GENY-B2 — `is_attach_enabled` 디폴트 true

**대상 파일**: `backend/service/memory_provider/config.py:213`

```python
def is_attach_enabled() -> bool:
    """Phase 4-A flag — wire MemoryProvider into Pipeline stages.
    Default `true` since path-A migration; legacy disable kept for
    bisecting regressions only.
    """
    return _env("MEMORY_PROVIDER_ATTACH", default="true").lower() in ("1", "true", "yes", "on")
```

코드 + docker-compose 둘 다 변경해야 환경변수 미지정 시에도 활성.

### 3.4 GENY-B3 — `attach_to_pipeline` 실패 → fail loud

**현재**: attach 실패 시 `logger.warning` + 계속 진행. 결과 stage 18 `_provider` 가 None 인 채로 동작 (회귀 재발 시 silent).

**변경**: attach 실패 시 `record_memory_event` 로 VTuber LOGS panel 에 surfacing + 백엔드 ERROR 로그. 운영자가 즉시 발견.

대상 파일: `backend/service/executor/agent_session_manager.py:851-854`

---

## 4. 통합 검증 (P0 PR 머지 후 docker rebuild)

### 4.1 자동 단위 테스트 (CI)

- executor: `tests/unit/test_memory_hooks_after_callbacks.py` 확장 케이스 통과.
- Geny: 신규 `backend/tests/service/memory/test_hook_chain_via_composite.py`
  - composite provider 빌드 + Geny 의 `_install_memory_hooks` 호출
  - mock callback 등록 → `STMHandle.append` 호출 → callback fire 확인.

### 4.2 수동 운영 검증 — P1 plan 으로 분리 (다음 plan 문서)

P1 plan 에서 docker rebuild + VTuber 세션 시나리오 + 디스크 확인 명령어 정리.

---

## 5. PR 시퀀스 + 의존성

```
EXEC-A1 (Protocol set_hooks 추가) ────┐
EXEC-A2 (composite forward) ─────────┤── geny-executor 1.17.2 release
EXEC-A3 (ephemeral/sql) ─────────────┘
                                       │
                                       ↓
GENY-B1 (docker-compose default true) ─┐
GENY-B2 (config.py default true) ──────┤── Geny PR #N (단일)
GENY-B3 (attach 실패 loud) ────────────┤   + requirements bump >=1.17.2
                                       ┘
```

총 PR: executor 1개 (EXEC-A1+A2+A3 통합) + release + Geny 1개 (GENY-B1+B2+B3 통합).

---

## 6. 위험 / 롤백

- **MEMORY_PROVIDER_ATTACH=true 가 기본이 되면서 stage 18 `_drive_provider` 가 매 turn 활성화** — STMHandle.append 가 record_message path 와 _drive_provider path **둘 다** 호출되는 시나리오 발생 가능 (이중 쓰기 재발).
  - 검증: `dedupe_strategy.py` 의 `_record_transcript` 가 GENY-2 이후 stamp-only 라 mgr.record_message 안 부름 → record_message path 는 agent-DM 도구만 사용. user/assistant 는 _drive_provider 단일 경로 → 이중 쓰기 없음.
  - 만약 이중 쓰기 surface 되면: GenyDedupeStrategy 의 `_stm_recorded_count` cursor 와 _drive_provider 의 `memory.last_recorded_idx` cursor 둘이 같은 messages slice 를 walk → 첫 cursor 가 메시지에 metadata stamp 후 두 번째 cursor 가 record. 이중 쓰기 X. 확인 완료.

- **롤백**: 회귀 발견 시 `MEMORY_PROVIDER_ATTACH=false` 환경변수 override 로 즉시 비활성화 (PR revert 안 해도 됨).

---

## 7. 결정사항 (사용자 확정)

1. **`set_hooks` Protocol 추가 + 확장성 우선 설계**. 단순히 `set_hooks(hooks)` 한 줄이 아니라, 미래에 추가될 hook 종류 (예: `PipelineHooks`, `RetrieverHooks`) 도 같은 패턴으로 들어올 수 있게 일반화된 surface. 즉 `set_hooks` 는 **typed hook bag** 을 받고, 모든 provider 가 자기가 알고 있는 hook 종류만 자기 store layer 에 forward.
2. **`is_attach_enabled` 환경변수 자체 폐기**. docker-compose 의 `MEMORY_PROVIDER_ATTACH` 변수도 제거. `attach_to_pipeline` 은 provider 가 빌드되면 무조건 호출. provider 빌드 자체가 실패한 경우만 stage attach skip.
3. **SQL provider 는 attribute 만 보유** (`self._hooks = hooks`). hook fire 는 후속 PR. SQL backend 가 현재 운영에서 사용 안 됨.

---

## 8. 다음 액션

1. 본 P0 plan 사용자 승인.
2. EXEC-A 3개 통합 PR 생성 → 1.17.2 release.
3. Geny GENY-B 3개 통합 PR 생성 → 1.17.2 dependency bump.
4. P1 plan (운영 검증 절차) 머지 + 사용자가 직접 docker rebuild + 시나리오 실행.
