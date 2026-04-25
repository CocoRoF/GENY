# Cycle B · 묶음 2 — Auto-compaction trigger (1 PR)

**묶음 ID:** B.2
**Layer:** EXEC-CORE only
**격차:** T.53 — claude-code 의 autoCompact (context fill ≥ N% 시 자동 summarize)

---

## PR-B.2.1 — feat(stages): Stage 19 frequency policy `on_context_fill`

### Metadata
- **Branch:** `feat/auto-compaction-trigger`
- **Repo:** geny-executor
- **Layer:** EXEC-CORE
- **Depends on:** none — Stage 19 (`s19_summarize`) 이미 ship.

### 동작 모델

```
매 turn 종료 후 (s19_summarize 가 frequency_policy 평가):
  if policy == "on_context_fill" and used_tokens / max_context_tokens >= threshold:
      summarize_strategy.summarize_now(scope="all")
```

### Files modified

#### `geny_executor/stages/s19_summarize/frequency_policy.py` (추가 또는 신설)

```python
class FrequencyPolicy(ABC):
    @abstractmethod
    async def should_fire(self, ctx: SummarizeContext) -> bool: ...


class NeverPolicy(FrequencyPolicy):
    async def should_fire(self, ctx) -> bool: return False


class EveryNTurnsPolicy(FrequencyPolicy):
    def __init__(self, n: int): self._n = n
    async def should_fire(self, ctx) -> bool: return ctx.turn_count > 0 and ctx.turn_count % self._n == 0


class OnContextFillPolicy(FrequencyPolicy):
    """Fire when token usage / max_context >= threshold."""

    def __init__(self, threshold: float = 0.8, min_turns_between: int = 5):
        self._threshold = threshold
        self._min_turns_between = min_turns_between

    async def should_fire(self, ctx: SummarizeContext) -> bool:
        if ctx.turn_count - ctx.last_summarized_turn < self._min_turns_between:
            return False
        used = ctx.input_tokens + ctx.output_tokens
        if ctx.max_context_tokens <= 0: return False
        ratio = used / ctx.max_context_tokens
        return ratio >= self._threshold


# manifest 의 frequency 등록
FREQUENCY_REGISTRY = {
    "never": NeverPolicy,
    "every_n_turns": EveryNTurnsPolicy,
    "on_context_fill": OnContextFillPolicy,
}
```

#### `geny_executor/stages/s19_summarize/strategy.py`

기존 `SummarizeStrategy.execute` 의 흐름 끝에 추가:

```python
async def execute(self, ctx):
    # ... 기존 manual summarize 로직
    
    # auto trigger
    policy = self.frequency_policy
    if await policy.should_fire(ctx):
        await self.summarize_now(scope=self.config.auto_scope or "since_last_brief")
```

#### `geny_executor/manifest/default.py`

`s19_summarize` slot 의 default frequency 를 `never` 유지 (additive). 운영자가 manifest 에서 `on_context_fill` 로 swap.

### Tests added

`tests/stages/s19_summarize/test_frequency_policy.py`

- `test_never_never_fires`
- `test_every_n_fires_at_multiples`
- `test_on_context_fill_below_threshold` (ratio=0.5, threshold=0.8 → no fire)
- `test_on_context_fill_above_threshold` (ratio=0.9 → fire)
- `test_on_context_fill_respects_min_turns_between` (이전 fire 후 5 turn 미만 → no fire)
- `test_on_context_fill_zero_max_context_no_fire` (division-by-zero 방어)

`tests/stages/s19_summarize/test_strategy_auto_trigger.py`

- `test_strategy_calls_summarize_when_policy_fires`
- `test_strategy_does_not_call_summarize_when_never_policy`

### Acceptance criteria
- [ ] OnContextFillPolicy ship
- [ ] 8 test pass
- [ ] line coverage ≥ 95%
- [ ] manifest default 변경 없음 (additive)
- [ ] CHANGELOG.md 1.2.0: "Add OnContextFillPolicy auto-compaction trigger"

### Risk / mitigation
| Risk | Mitigation |
|---|---|
| 계속 fire (threshold 직후) → 무한 summarize | min_turns_between (default 5) |
| max_context_tokens=0 → division-by-zero | guard (return False) |
| summarize 비용 증가 | LLM call 1회 — 비용 측정 필요 (CostBudgetGuard 가 이미 가드) |

### 운영 적용 가이드 (Geny 측에서는 별도 PR 없음)

운영자가 manifest 에 추가:
```yaml
s19_summarize:
  frequency: on_context_fill
  threshold: 0.8
  min_turns_between: 5
  auto_scope: since_last_brief
```

또는 `/compact threshold=0.8` 같은 slash command (P0.2 의 `/compact` 활용).

---

## 묶음 합계

| PR | Repo | 의존 |
|---|---|---|
| PR-B.2.1 | executor | — |

총 1 PR. 다음: [`cycle_B_p1_3_settings.md`](cycle_B_p1_3_settings.md).
