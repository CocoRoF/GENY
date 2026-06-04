# B3 — 모델 / sampling param 처리 정밀 감사 + 강건화 계획

> **Date**: 2026-06-01
> **Method**: Geny (frontend + backend + executor lib) 4-방향 병렬 코드 정독 + Anthropic API 의 명시된 제약 확인
> **Trigger**:
>   * Error #1: `400 — temperature is deprecated for this model.`
>   * Error #2: `404 — model: opus`

---

## 1. 두 에러의 정확한 root cause

### Error #1 — `temperature is deprecated for this model.` (400)

Anthropic API 의 명시된 제약:
- **extended thinking 모드 활성** 시 `temperature` 가 deprecated (Anthropic 의 *추론 결정성* 보장 — thinking 가 자체적으로 sampling 을 제어).
- API spec 상 `thinking.type == "enabled"` 인 요청에 `temperature` 가 들어가면 400 반환.

geny-executor 의 현재 구현:

| 위치 | 코드 | 문제 |
|---|---|---|
| `core/config.py:28` | `temperature: float = 0.0` | dataclass 기본값 always set |
| `llm_client/base.py:177` | `temperature=model_config.temperature` | request 에 무조건 복사 |
| `llm_client/anthropic.py:136-137` | `if request.temperature is not None: kwargs["temperature"] = ...` | thinking 활성 여부 무관, 단순 None 체크 |

→ **executor 는 thinking + temperature 충돌을 절대 안 막음**. thinking_enabled=True + temperature=0.0 (또는 다른 값) 면 무조건 400.

### Error #2 — `model: opus` (404)

`opus` 는 alias. Anthropic API 는 canonical ID(`claude-opus-4-7`, `claude-opus-4-6` 등)만 받음.

geny-executor 의 alias 처리:
- `llm_client/translators/_cli.py:124-126` — claude_code_cli 경로는 alias 를 그대로 CLI 바이너리에 전달 (CLI 가 alias 해석을 책임짐).
- `llm_client/anthropic.py:_build_kwargs` — alias 해석 **전혀 없음**. `request.model` 을 그대로 SDK 의 `model=...` 인자로 전송.

Geny 의 model 입력 path:
- frontend `MODEL_CATALOG` (modelCatalog.ts):
  - `anthropic` 카탈로그 (9개): 모두 canonical ID
  - `claude_code_cli` 카탈로그 (12개): canonical + alias 모두 포함 (`sonnet`, `opus`, `haiku`)
- `ModelPicker.tsx:69-71` — value 가 catalog 에 없으면 **freeform custom mode** 진입 → 사용자가 임의 입력 가능
- `ModelConfigEditor.tsx:105-162 buildChanges()` — model 필드 **검증 없음** (`temperature`/`top_p` 의 range 검증만)
- backend `schemas.py:142` — `model: Optional[str] = None`, 타입만 체크
- `service.py:671 update_model()` — shallow merge, validation 없음
- executor `ModelConfig.from_dict()` (config.py:57-80) — unknown key 무시, validation 없음

→ **5층 모두 검증 부재**. 사용자가 anthropic provider 에서 "opus" 입력하면 manifest 에 저장됨 → 세션 시작 시 404.

---

## 2. 추가로 발견된 약점 (W16-W19)

### W16 — Provider 가 바뀌어도 model 이 안 따라옴

`ModelConfigEditor` 에서 provider 토글 (anthropic ↔ claude_code_cli ↔ openai) 했을 때 model 필드가 자동 갱신되지 않음:

```typescript
// ModelConfigEditor.tsx 의 handleProviderChange 추정 (frontend 정독 결과)
// 새 provider 의 catalog 에 현재 model id 가 있으면 유지, 없으면 default 로 교체
const inCatalog = MODEL_CATALOG[next].some((o) => o.id === currentModel);
if (!inCatalog) patchModel({ model: PROVIDER_DEFAULT_MODEL[next] });
```

여기서:
- `claude_code_cli` 선택 → model="opus" 입력 → catalog 에 있어 유지
- provider 를 `anthropic` 으로 변경 → "opus" 가 anthropic catalog 에 없음 → default 로 교체

이론적으로는 잘 동작. 하지만 사용자가 "Apply" 누르지 않고 또는 빠르게 토글 시 race condition 가능. 더 큰 문제: **이미 저장된 manifest** 의 provider 가 나중에 변경되면 같은 문제 발생.

### W17 — Frontend `inferProvider()` 의 잠재적 misdetection

`modelCatalog.ts:164-196` 의 `inferProvider(modelId)`:
- "opus" → CLI-exclusive id 로 인식 → `claude_code_cli` 반환
- "claude-opus-4-7" → prefix 매칭으로 `anthropic` 반환

→ 사용자가 model 만 직접 입력하면 provider 가 자동 추론됨. 의도된 행동이지만 explicit provider 선택과 충돌 시 어느 쪽이 이기는지 불명확.

### W18 — `MAX_THINKING_TOKENS` env var 가 strategy 단계에서 thinking 을 자동 활성화

memory 의 `reference_geny_executor_v2_1` 참조 — Geny 는 환경변수로 thinking budget 을 셋팅하고, 일부 단계 (메모리, 평가) 에서 자동으로 thinking_enabled 활성화 가능. 사용자는 모르지만 enabled=True 가 흘러들어가 temperature 충돌 트리거.

### W19 — Anthropic SDK 의 silent message normalization

executor `llm_client/anthropic.py:_build_kwargs` 가 messages 를 sanitize 하지만 thinking 가 들어간 메시지 (`type:"thinking"` block) 처리는 별도 — 메시지 안에 thinking_signature 가 있으면 다음 turn 에서 temperature 가 필요 없는 컨텍스트가 자동 형성. **이미 잘 처리됨**, 보고용.

---

## 3. 강건화 계획 (3 layer 방어)

문제는 5층에 걸쳐 있으니 정정도 5층 정합으로:

### Layer 1 — Frontend write-time validation

목표: 잘못된 model/alias 가 manifest 에 저장되지 않게.

`ModelConfigEditor.tsx` 의 `buildChanges()` 에 추가:
```typescript
// alias 감지 + provider 매칭 검증
const ALIAS_TO_CANONICAL: Record<string, string> = {
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-7',
  haiku: 'claude-haiku-4-5-20251001',
};

const resolveModel = (input: string, provider: ProviderId): {
  ok: boolean;
  resolved: string;
  warning?: string;
} => {
  // alias 입력
  if (input in ALIAS_TO_CANONICAL) {
    if (provider === 'claude_code_cli') {
      // CLI 가 alias 직접 처리 — 그대로 사용 OK
      return { ok: true, resolved: input };
    }
    // anthropic / openai / etc — canonical 로 expand
    return {
      ok: true,
      resolved: ALIAS_TO_CANONICAL[input],
      warning: `"${input}" → "${ALIAS_TO_CANONICAL[input]}" 로 변환됨 (${provider} 백엔드는 canonical ID 필요)`,
    };
  }
  // catalog 매칭 확인
  const inCatalog = MODEL_CATALOG[provider]?.some((o) => o.id === input);
  if (!inCatalog) {
    return {
      ok: false,
      resolved: input,
      warning: `"${input}" 은 ${provider} 백엔드의 catalog 에 없음. 정확한 model ID 를 사용하세요.`,
    };
  }
  return { ok: true, resolved: input };
};
```

`onSave` 호출 전에 `resolveModel()` 적용, warning 표시.

### Layer 2 — Backend write-time canonicalization

목표: API 우회 호출 (curl 등) 도 막음.

`backend/service/environment/service.py:update_model()` 또는 `controller/environment_controller.py:patch_model()` 에 추가:

```python
# alias → canonical 매핑 (Geny 호스트 측 책임)
_MODEL_ALIASES = {
    "sonnet": "claude-sonnet-4-6",
    "opus": "claude-opus-4-7",
    "haiku": "claude-haiku-4-5-20251001",
}

def _canonicalize_model(model: str, stage6_provider: str) -> str:
    """Resolve alias when the active provider needs canonical IDs."""
    if model in _MODEL_ALIASES:
        if stage6_provider == "claude_code_cli":
            return model  # CLI handles aliases natively
        return _MODEL_ALIASES[model]  # everyone else needs canonical
    return model

# update_model() 안에서:
provider = manifest.stage_entries()...['provider'] or "anthropic"
changes["model"] = _canonicalize_model(changes["model"], provider)
```

또한 unknown model ID 는 422 로 reject:
```python
KNOWN_MODELS_BY_PROVIDER = {
    "anthropic": {"claude-opus-4-7", "claude-sonnet-4-6", ..., },
    "openai":    {"gpt-5", "gpt-5-mini", ...},
    "google":    {"gemini-3-pro", ...},
    "claude_code_cli": {...alias 들 + canonical 들},
    "vllm": None,  # vllm 은 freeform 허용 (self-host)
}

if KNOWN_MODELS_BY_PROVIDER[provider] is not None:
    if changes["model"] not in KNOWN_MODELS_BY_PROVIDER[provider]:
        raise HTTPException(422, f"unknown model '{changes['model']}' for provider {provider}")
```

### Layer 3 — Runtime safety net (`llm_patches.py`)

목표: 어떤 경로로 manifest 가 깨져도 세션 호출은 깨지지 않게.

`backend/service/llm_patches.py` 에 새 patch:

```python
def _install_anthropic_thinking_temperature_guard() -> None:
    """Drop ``temperature`` from kwargs when ``thinking`` is set.

    Anthropic API 가 thinking 활성 모델에 temperature 보내면 400 반환.
    Manifest 가 깨져있어도 이 guard 가 마지막 안전망.
    """
    import importlib
    try:
        ant_mod = importlib.import_module("geny_executor.llm_client.anthropic")
    except ImportError:
        return
    cls = getattr(ant_mod, "AnthropicClient", None)
    if cls is None: return
    if getattr(cls, "_geny_thinking_guard_applied", False): return

    original_build_kwargs = cls._build_kwargs

    def _patched_build_kwargs(self, request):
        kwargs = original_build_kwargs(self, request)
        if kwargs.get("thinking") and "temperature" in kwargs:
            # thinking 활성 — temperature drop
            kwargs.pop("temperature", None)
            logger.info(
                "anthropic: thinking enabled, dropped temperature "
                "(model=%s)", kwargs.get("model"),
            )
        return kwargs

    cls._build_kwargs = _patched_build_kwargs
    cls._geny_thinking_guard_applied = True
    logger.info("[llm_patches] installed Anthropic thinking+temperature guard")
```

추가로 `install_llm_patches()` 에 alias resolution patch:

```python
def _install_anthropic_alias_guard() -> None:
    """Resolve common Claude aliases to canonical IDs.

    Last-line defense against manifest values that bypass the
    backend canonicalization (cycle 20260525_1 B3) — e.g. envs
    seeded by an older client or hand-edited JSON files.
    """
    _ALIAS_MAP = {
        "sonnet": "claude-sonnet-4-6",
        "opus":   "claude-opus-4-7",
        "haiku":  "claude-haiku-4-5-20251001",
    }
    cls = ...  # AnthropicClient
    original = cls._build_kwargs

    def _patched(self, request):
        if request.model in _ALIAS_MAP:
            request.model = _ALIAS_MAP[request.model]
        return original(self, request)

    cls._build_kwargs = _patched
```

### 어디서 가장 큰 효과?

| Layer | Pros | Cons | 적용 |
|---|---|---|---|
| **L1 (Frontend)** | UX 명확, 즉시 피드백 | 우회 가능 (curl) | 우선순위 高 |
| **L2 (Backend write)** | DB 무결성 보장 | 입력 시점만, 이미 깨진 manifest 못 잡음 | 우선순위 高 |
| **L3 (Runtime patch)** | 모든 경로 안전망 | 침습적 (monkey-patch) | **반드시 필요** |

**3층 모두** 적용하는 게 정답. Frontend = UX, Backend = 데이터 무결성, Runtime = 마지막 보루.

---

## 4. PR 분할 안

| PR | 내용 | 라인 추정 |
|---|---|---|
| **R1** | Runtime guard (`llm_patches.py` 의 thinking+temperature drop + alias resolution) + 회귀 테스트 | ~250 |
| **R2** | Backend write-time canonicalize + validate (`schemas.py` + `service.py:update_model`) + 422 unknown-model | ~200 |
| **R3** | Frontend alias resolve + warning chip 표시 (`ModelConfigEditor.tsx`) | ~150 |
| **R4** (선택) | upstream geny-executor 수정 — `AnthropicClient._build_kwargs` 가 thinking 시 temperature drop. PyPI 새 버전. Long-tail. | repo 별도 |

**머지 순서**: R1 → 즉시 prod 에 배포 → R2 → R3. R4 는 별도 cycle.

R1 이 핵심 — 사용자가 envs 를 갈아엎지 않고도 즉시 해결됨.

---

## 5. 결정 필요 사항 (사용자 확인 후 진행)

1. **alias 처리 정책**:
   - (A) 모든 비-CLI provider 에서 alias → canonical 자동 expand (조용히)
   - (B) Warning 표시 후 expand
   - **(C) 추천**: anthropic/openai/google 에서는 명시적 canonical 만 허용 (alias 입력 시 422 + 친절한 메시지). claude_code_cli 만 alias 허용.
2. **불명 model ID 처리**:
   - vllm 은 self-host 라 freeform 허용
   - 그 외 provider 는 catalog 매칭 강제 (모르는 ID 는 422)
3. **PR 머지 순서**: R1 → R2 → R3 OK? 또는 다른 순서?
4. **Frontend warning 위치**: model picker 자체 (실시간) vs 저장 버튼 클릭 시 (모달 confirm)?

답주면 R1 부터 진행.
