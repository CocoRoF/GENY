# Phase 5 — PR 5B: TTS Configs voice-studio/settings 통합 PLAN

> 사용자가 보여준 Geny 메인 설정 페이지의 **TTS 카테고리 (5 카드)** —
> Edge TTS · ElevenLabs · OmniVoice · OpenAI TTS · General — 를
> `/voice-studio/settings`에서도 동일하게 편집 가능하게 한다.
>
> 기존 `configApi` (`GET /api/config`, `PUT /api/config/{name}`) 이미 존재 +
> Geny `SettingsTab.tsx`의 schema-driven generic editor를 재사용 → backend 0 변경.
>
> 사용자 메모리 `feedback_verify_code_over_docs.md` 준수 — SettingsTab + configApi
> 시그너처 코드로 검증 완료.

---

## 0. 스코프 요약

### 포함 (PR 5B)
- `SettingsTab.tsx` 내부 `ConfigFieldInput` + `getLocalizedSchema` / `getLocalizedField` / `getLocalizedGroup` 헬퍼를 **export** (동작 무변경).
- **신규** `components/voice-studio/TtsConfigsSection.tsx`:
  - `configApi.list()` → `schema.category === 'tts'` 필터링 → 카드 그리드.
  - 카드 클릭 → 모달 폼 (그룹별 섹션 + `ConfigFieldInput` 재사용) → `configApi.update`.
  - Reset (`configApi.reset`) + 검증 메시지.
- `app/voice-studio/settings/page.tsx`에 `<TtsConfigsSection />` 추가. 기존 3 카드(EngineMatrix / OmniVoiceDefaults / Cache) 위 또는 아래.
- 신규 `OmniVoiceDefaultsCard`는 그대로 두되 **TTS Configs 섹션의 OmniVoice 카드와 역할 분담** 표시:
  - OmniVoiceDefaults는 "Synthesize 카드 advanced 패널 초기값" 빠른 편집 (6 필드).
  - TtsConfigs 의 OmniVoice 카드는 14 필드 모든 옵션 (api_url, timeout, mode, voice_profile, instruct, language, num_step, guidance_scale, speed, duration, denoise, audio_format, auto_asr 등).
- i18n — `voiceStudio.settings.ttsConfigs.*` (ko/en, 짧은 헤더 + 안내문).

### 제외 / 후순위
- SettingsTab 자체의 코드 동작 변경 — **0**. 단지 export 추가만.
- Geny 메인 설정 페이지 (`/setup` 또는 어디)의 TTS 카테고리는 그대로 유지 — 둘 다 같은 backend endpoint를 가리키므로 자동 동기화.
- 새 backend — 없음.
- 새 schema 추가 — 없음.

### 호환 보장
- `configApi.list/get/update/reset` 시그너처 무변경.
- 기존 SettingsTab UI 무변경 (export 추가 외).
- `/voice-studio/settings`의 기존 3 카드 그대로.

---

## 1. 영향 범위

### 1.1 수정
- `frontend/src/components/tabs/SettingsTab.tsx` — `ConfigFieldInput` + 헬퍼 3개에 `export` 추가 (5줄 정도).
- `frontend/src/app/voice-studio/settings/page.tsx` — `<TtsConfigsSection />` import + mount.
- `frontend/src/lib/i18n/ko.ts` + `en.ts` — `voiceStudio.settings.ttsConfigs.*` 신규.

### 1.2 신규
- `frontend/src/components/voice-studio/TtsConfigsSection.tsx`

### 1.3 Backend
- 0 변경.

---

## 2. 구체 명세

### 2.1 `SettingsTab.tsx` 의 export 추가

라인 20-58 헬퍼 + 라인 349 ConfigFieldInput에 `export` 키워드 추가:

```ts
export function getLocalizedSchema(...)
export function getLocalizedField(...)
export function getLocalizedGroup(...)
export function ConfigFieldInput(...)
```

다른 코드는 그대로 동작 (default export는 SettingsTab function).

### 2.2 `TtsConfigsSection.tsx` 구조

```tsx
'use client';

export default function TtsConfigsSection() {
  // 1) configApi.list() — TTS 카테고리만 필터링
  // 2) 카드 그리드: display_name + description + (필드 X / 전체) + active badge
  // 3) 카드 클릭 → 모달:
  //    - 그룹별 섹션
  //    - 각 필드는 ConfigFieldInput 재사용
  //    - Save / Reset / Cancel
  //    - 에러 메시지
  // 4) Save 성공 → 카드 list refresh + toast
}
```

핵심 동작:
- list `categorize`: `configs.filter(c => c.schema?.category === 'tts')`
- "활성" 표시: schema에 `enabled` 필드가 있고 `values.enabled === true`. (사용자 스크린샷의 "활성화" 배지 패턴.)
- "n / 전체 필드 설정됨": secure 필드는 값이 non-empty면 count, 나머지는 default 와 다르면 count. 단순화: SettingsTab과 동일 로직 — 사용자가 본 스크린샷 모양 reproduce.

→ 사용자 스크린샷에서 "3/3개 필드 설정됨", "4/6개 필드 설정됨" 등은 정확한 룰이 SettingsTab 내부에 있을 것. 거기에 맞춰 같은 셈법 사용.

### 2.3 `settings/page.tsx` 변경

```tsx
import EngineMatrixCard from '@/components/voice-studio/EngineMatrixCard';
import OmniVoiceDefaultsCard from '@/components/voice-studio/OmniVoiceDefaultsCard';
import CacheCard from '@/components/voice-studio/CacheCard';
import TtsConfigsSection from '@/components/voice-studio/TtsConfigsSection';

export default function SettingsPage() {
  return (
    <div className="max-w-4xl mx-auto px-6 py-6 space-y-4">
      <EngineMatrixCard />
      <TtsConfigsSection />
      <OmniVoiceDefaultsCard />
      <CacheCard />
    </div>
  );
}
```

순서: Engine Matrix (어느 엔진 쓸지 결정) → TTS Configs (그 엔진 세부 설정) → OmniVoice Defaults (Synthesize 카드 초기값 빠른 편집) → Cache.

### 2.4 i18n 신규 키

ko:
```ts
ttsConfigs: {
  title: 'TTS 엔진 설정',
  hint: '각 엔진의 상세 설정을 편집합니다. 변경은 즉시 적용되며 채팅 / Synthesize / Batch 모두에 반영됩니다.',
  loading: '설정 로딩 중...',
  empty: 'TTS 설정이 없습니다.',
  fieldsConfigured: '{n}/{total}개 필드 설정됨',
  enabled: '활성화',
  notEnabled: '비활성',
  save: '저장',
  saving: '저장 중...',
  reset: '기본값으로 재설정',
  resetConfirm: '{name} 설정을 기본값으로 되돌립니다. 계속할까요?',
  cancel: '취소',
  saved: '저장되었습니다.',
  resetDone: '재설정되었습니다.',
},
```

en: 동일 의미.

---

## 3. 작업 순서

1. branch `feature/voice-studio-phase5b`
2. SettingsTab.tsx에 export 추가 (회귀 위험 없도록 동작 변경 0)
3. TtsConfigsSection.tsx 작성
4. settings/page.tsx 에 mount
5. i18n
6. `npm run build` 0 errors
7. commit + PR + 머지 + 배포

---

## 4. 검증

### 4.1 정적
- `npm run build` 0 errors
- 기존 `/setup` SettingsTab 정상 (해당 라우트의 visual diff 없음)

### 4.2 런타임
- `/voice-studio/settings` 진입 → 4개 섹션 (Engine Matrix → TTS Configs → OmniVoice Defaults → Cache)
- TTS Configs 카드 5개 (Edge TTS / ElevenLabs / OmniVoice / OpenAI TTS / General) 표시
- OmniVoice 카드 클릭 → 모달 폼 → num_step 변경 → Save → 카드의 "활성화" 배지/필드 카운트 갱신
- 동시에 `configApi.get('tts_omnivoice')` 결과에 새 값 반영
- 회귀: 메인 `/setup` SettingsTab의 TTS 카테고리에서 같은 값 보임 (양쪽이 같은 backend store 공유)
- 에이전트 채팅 TTS / `/voice-studio/clone-design` 변경 없음

---

## 5. 리스크

| 리스크 | 완화 |
|---|---|
| SettingsTab의 ConfigFieldInput이 dirty internal state 보유 | 함수 컴포넌트 + props-driven, dirty state 없음. 안전 |
| OmniVoice 카드가 두 곳에서 나옴 (TTS Configs + OmniVoiceDefaults) | UI 라벨로 역할 분담 안내. 둘 다 같은 backend store 공유 → 양방향 갱신 |
| 'tts_general'의 provider 필드 변경이 EngineMatrix 의 default 라디오와 충돌 | 둘 다 같은 backend 키 (`tts_general_config.provider` + settings_store mirror) → 자동 동기화. EngineMatrix는 컴포넌트 mount 시점 fresh fetch |
| ConfigFieldInput이 secure 필드를 마스킹하나 | SettingsTab이 그렇게 하면 우리도 동일 — 직접 사용 |
| i18n 키 누락 | grep 검증 |

---

## 6. PR 정보

- 브랜치: `feature/voice-studio-phase5b`
- 제목: `feat(voice-studio): integrate 5 TTS configs into /voice-studio/settings`
- 본문: §0 요약 + test plan

---

## 7. 다음 단계

PR 5B 머지 → Voice Studio 핵심 작업 완료. 향후 Phase 6 (옵션): IndexTTS2 / VoxCPM2 신규 엔진 흡수.
