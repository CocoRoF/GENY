# Phase 5 — PR 5A: tts-voice 페이지 제거 + voice-studio 안전성 확보 PLAN

> Voice Studio가 충분히 무르익었으니 legacy `/tts-voice` 페이지를 정리.
>
> **두 가지 사전 작업이 필요**:
> 1. `voice-studio/voices` 페이지에 **신규 프로필 생성 모달이 빠져있다** —
>    legacy tts-voice의 `CreateProfileForm`을 voice-studio용 모달로 이식.
> 2. 옛 `/tts-voice` URL 북마크·외부 링크 보호를 위해 **redirect** 처리.
>
> 이번 사이클: tts-voice 제거 + CreateProfileModal + Header 정리 + StudioPromoBanner 정리.
> TTS Config 통합은 별도 PR 5B에서.

---

## 0. 스코프 요약

### 포함 (PR 5A)
- **신규**: `components/voice-studio/CreateProfileModal.tsx` — name + display_name + language 입력. `ttsApi.createProfile` 호출.
- **voices/page.tsx** — header 우측에 "+ New" 버튼 + 모달 wire.
- **tts-voice/page.tsx** — 565줄 본체를 **server-side redirect 1줄**로 교체 (`/voice-studio/clone-design`로 영구 redirect). 옛 URL 살아있음.
- **Header.tsx** — TTS Voice 아이콘(`AudioLines`) Link 제거. 다른 아이콘들(Sliders 등) 그대로.
- **StudioPromoBanner.tsx + 사용처** — 제거 (tts-voice가 redirect되므로 무의미).
- **i18n** — `header.ttsVoice` + `ttsVoice.studioPromoBanner.*` 키 제거. `ttsVoice.emotionRefs` 등 EmotionRefSection이 재사용하는 키는 **유지** (실제 voice-studio가 쓰고 있음).

### 제외 (PR 5A 아님)
- TTS config 통합 → PR 5B.
- `omnivoice` 마이크로서비스, `/api/tts/*` 무변경.

### 호환 보장
- 옛 `/tts-voice` URL → 자동 redirect (HTTP 308 또는 Next.js client redirect).
- 기존 `ttsApi` 메서드 (createProfile 포함) **무변경** — 모달이 그대로 호출.
- 기존 4 템플릿 + 사용자 프로필 그대로.

---

## 1. 영향 범위

### 1.1 신규
- `frontend/src/components/voice-studio/CreateProfileModal.tsx`

### 1.2 수정
- `frontend/src/app/voice-studio/voices/page.tsx` — "+ New" 버튼 + 모달 mount + 생성 후 list refresh
- `frontend/src/app/tts-voice/page.tsx` — 565줄 → `redirect()` 1줄 server component
- `frontend/src/components/Header.tsx` — TTS Voice Link 제거 (다른 아이콘들 무변경)
- `frontend/src/lib/i18n/ko.ts` + `en.ts` — `header.ttsVoice` 제거 + `ttsVoice.studioPromoBanner` 제거

### 1.3 삭제
- `frontend/src/components/voice-studio/StudioPromoBanner.tsx`
- (위 i18n 키들)

### 1.4 그대로
- `frontend/src/components/voice-studio/EmotionRefSection.tsx` — `ttsVoice.emotionRefs` / `ttsVoice.upload` 등 i18n 키를 그대로 재사용. 키 이름이 어색하지만 동작은 정확. 향후 별 작업으로 `voiceStudio.refSection.*`으로 리네이밍할 수도 있음 (이번 PR 스코프 외).
- `ttsApi` 객체 전체 (api.ts).
- backend 0 변경.

---

## 2. 구체 명세

### 2.1 `CreateProfileModal.tsx` (신규)

```tsx
'use client';

import { useCallback, useState } from 'react';
import { Loader2, X, Plus } from 'lucide-react';
import { ttsApi } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: (name: string) => void;
}

const LANGUAGES = [
  { value: 'ko', label: '한국어' },
  { value: 'ja', label: '日本語' },
  { value: 'en', label: 'English' },
  { value: 'zh', label: '中文' },
];

export default function CreateProfileModal({ open, onClose, onCreated }: Props) {
  // form: name (slug-ish), display_name, language
  // sanitize: name.replace(/[^\p{L}\p{N}_-]/gu, '_')
  // 호출: ttsApi.createProfile({ name, display_name, language })
  // 성공 → onCreated(name) + onClose
}
```

(자세한 코드는 작업 단계에서 작성 — 기존 tts-voice/page.tsx 의 `CreateProfileForm` 로직과 동일 패턴 + 모달 chrome.)

### 2.2 `voices/page.tsx` — "+ New" 액션 추가

`<Search>` 옆 또는 toolbar 끝에 버튼 추가:
```tsx
<button onClick={() => setCreateOpen(true)}>+ New</button>
...
<CreateProfileModal
  open={createOpen}
  onClose={() => setCreateOpen(false)}
  onCreated={() => { setCreateOpen(false); load(); }}
/>
```

### 2.3 `tts-voice/page.tsx` 교체

```tsx
import { redirect } from 'next/navigation';

/** Legacy /tts-voice route — kept as a permanent redirect so old
 * bookmarks/links keep working. The actual UI lives at
 * /voice-studio/clone-design (and surrounding voice-studio routes). */
export default function LegacyTtsVoicePage() {
  redirect('/voice-studio/clone-design');
}
```

'use client' 제거 (server component로 동작). `useEffect` import 등 다 제거.

### 2.4 `Header.tsx` — TTS Voice 아이콘 제거

```tsx
// 제거할 블록 (라인 89-96 근처):
{/* ── TTS Voice Button — hidden on mobile ── */}
<Link href="/tts-voice" ...>
  <AudioLines size={14} />
</Link>
```

또한 import에서 `AudioLines`도 다른 곳에서 안 쓰면 제거. (Sliders는 voice-studio 유지)

### 2.5 `StudioPromoBanner.tsx` 삭제

- 파일 삭제: `frontend/src/components/voice-studio/StudioPromoBanner.tsx`
- (이전 PR에서 이미 tts-voice/page.tsx에서 사용했지만 §2.3에서 통째로 redirect로 바뀌면서 자연 제거)
- i18n 키 `ttsVoice.studioPromoBanner.*` (ko + en) 제거

### 2.6 i18n 정리

ko/en 둘 다:
- `header.ttsVoice` 제거 (Header에서 사용 안 함)
- `ttsVoice.studioPromoBanner` 객체 전체 제거

→ 안전 검증: `grep -r "header.ttsVoice\|studioPromoBanner" frontend/src` → 두 키가 더 이상 참조되지 않는지 확인.

`ttsVoice.title` / `ttsVoice.emotionRefs` / `ttsVoice.upload` 등 ref 워크플로우 키는 **유지** (EmotionRefSection이 사용 중).

---

## 3. 작업 순서

1. branch `feature/voice-studio-phase5a`
2. `CreateProfileModal.tsx` 작성
3. `voices/page.tsx` "+ New" 버튼 + 모달 wire
4. `tts-voice/page.tsx` redirect로 교체
5. `Header.tsx` TTS Voice Link 제거
6. `StudioPromoBanner.tsx` 삭제 + i18n 키 제거
7. `npm run build` 0 errors + grep 안전성 검증
8. commit + PR + 머지 + 배포 + 검증

---

## 4. 검증

### 4.1 정적
- `npm run build` — 17 routes (변동 없음, /tts-voice 는 redirect라도 route는 살아있음)
- `grep -r "header.ttsVoice\|studioPromoBanner\|StudioPromoBanner" frontend/src` → 0 hits (i18n 키 + 컴포넌트 임포트 잔재 없음)

### 4.2 런타임
- `/tts-voice` 접속 → 308 redirect → `/voice-studio/clone-design`
- `/voice-studio/voices` → "+ New" 버튼 → 모달 → 입력 → 생성 → list refresh + 새 프로필 표시
- 신규 프로필을 active로 → ref 업로드 → clone-design에서 합성 정상
- Header에 TTS Voice (AudioLines) 아이콘 사라짐, Voice Studio (Sliders) 아이콘 유지
- 회귀: 에이전트 채팅 TTS / 다른 voice-studio 페이지 정상

---

## 5. 리스크

| 리스크 | 완화 |
|---|---|
| 옛 외부 링크 깨짐 | redirect 유지로 보호 |
| ttsApi.createProfile 시그너처 변경된 경우 | api.ts grep으로 확인 (변경 없음 — `{name, display_name, language, prompt_text?, prompt_lang?}`) |
| Next.js redirect가 client component에서 안 됨 | server component로 작성 (use client 제거) |
| i18n 키 제거가 다른 곳에서 깨짐 | grep로 두 키 모두 0 hits 확인 |
| EmotionRefSection이 ttsVoice.* 키 못 찾음 | 키는 유지 (ttsVoice.studioPromoBanner만 제거) |

---

## 6. PR 정보

- 브랜치: `feature/voice-studio-phase5a`
- 제목: `feat(voice-studio): retire /tts-voice page + add CreateProfile modal to /voices`
- 본문: §0 요약 + test plan

---

## 7. 다음 단계

PR 5A 머지 → PR 5B (`/voice-studio/settings`에 5종 TTS config 카드 통합, configApi 활용).
