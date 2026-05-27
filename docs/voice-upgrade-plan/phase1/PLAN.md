# Phase 1 — PR 1A: `/voice-studio` 라우팅 + Voices 카탈로그 + 진입점 PLAN

> "Geny를 위한 OmniVoice 컨트롤 스튜디오"의 첫 PR.
> 기존 `tts-voice` 페이지는 **건드리지 않고** 상단 배너 1줄만 추가.
> Header에 Voice Studio 아이콘 버튼 추가 (TTS Voice 아이콘 옆).
> `/voice-studio` 5탭 라우팅 골격을 깔고 `/voice-studio/voices` (프로필 카탈로그)를 1차 구현.
> 나머지 4탭(`clone-design`, `batch`, `tools`, `settings`)은 PR 1A 기준 **placeholder** ("Coming in Phase N" 안내).
>
> 사용자 메모리 `feedback_verify_code_over_docs.md` 준수 — 04 문서가 추정한 "Sidebar 메뉴 추가"는
> 실제 코드 검증 결과 잘못. Voice Studio 진입은 **Header.tsx의 아이콘 버튼** ([Header.tsx:89-96](../../../frontend/src/components/Header.tsx#L89-L96) 이 TTS Voice 진입점) 옆에 추가하는 게 일관됨.

---

## 0. 스코프 요약

### 포함 (PR 1A)
- `/voice-studio` Next.js App Router 라우팅 골격 (entry redirect + 5 child routes)
- `/voice-studio/layout.tsx` — 좌측 네비 5메뉴 + 공통 헤더
- `/voice-studio/voices` — **실작동**: 프로필 카드 그리드 + 검색 + 필터 + 클릭 시 placeholder 상세
- 나머지 4탭 페이지 — placeholder
- Header.tsx 에 Voice Studio 아이콘 (Sliders) 추가 — TTS Voice 옆
- `/tts-voice` 페이지 상단에 `<StudioPromoBanner />` — dismissable + localStorage 영속
- `voiceStudioApi` 객체 (lib/voiceStudioApi.ts) — PR 1A 기준 비어있음, PR 1B부터 채움
- i18n 신규 키 ko/en (ja/zh는 미존재 — 04 문서 오기)

### 제외 (PR 1A 아님)
- 합성 미리듣기 (`/voice-studio/clone-design`의 본격 구현) — PR 1B
- 마이크 녹음 + 트리밍 — PR 2A
- 엔진 메타데이터 + Compatibility Matrix — Phase 3
- Batch / Tools 본격 구현 — Phase 4
- 백엔드 변경 — PR 1A는 **백엔드 0 변경** (기존 `ttsApi.listProfiles()` 사용)

### 호환 보장
- 기존 `/tts-voice` 페이지 코드 무변경 (배너 1줄만 추가)
- 기존 `ttsApi` 모든 메서드 그대로
- Header.tsx 의 기존 5 아이콘 (Wiki, TTS Voice, Avatar Editor, Memory, ...) 그대로
- 백엔드 회귀 없음 (백엔드 변경 0건)

---

## 1. 영향 범위 (정밀 매핑)

### 1.1 신규 파일

**Pages** (`frontend/src/app/voice-studio/`):
- `layout.tsx` — Voice Studio 전용 레이아웃 (좌측 SideNav 포함)
- `page.tsx` — entry, Next.js `redirect()` → `/voice-studio/clone-design`
- `clone-design/page.tsx` — placeholder (PR 1B에서 본격 구현)
- `voices/page.tsx` — **실작동 카드 그리드**
- `batch/page.tsx` — placeholder ("Coming in Phase 4")
- `tools/page.tsx` — placeholder ("Coming in Phase 4")
- `settings/page.tsx` — placeholder ("Coming in Phase 3")

**Components** (`frontend/src/components/voice-studio/`):
- `SideNav.tsx` — 5메뉴 좌측 네비 (lucide 아이콘 + 라벨, 활성 탭 highlight)
- `VoiceCard.tsx` — Voices 페이지의 프로필 카드 (이름, 언어, 감정 ref 수, active 별)
- `StudioPromoBanner.tsx` — tts-voice 상단 배너 (dismissable)

**Lib** (`frontend/src/lib/`):
- `voiceStudioApi.ts` — 신규 API 객체. PR 1A 기준 비어있음 (placeholder export).

### 1.2 수정 파일

- `frontend/src/components/Header.tsx` — TTS Voice 아이콘 옆에 Voice Studio 아이콘 1개 추가 (lucide `Sliders`).
- `frontend/src/app/tts-voice/page.tsx` — 565줄. **위에서 두 번째 컴포넌트 직전에 `<StudioPromoBanner />` 한 줄 삽입**. 다른 코드 변경 없음.
- `frontend/src/lib/i18n/ko.ts` — `header.voiceStudio`, `ttsVoice.studioPromoBanner.*`, `voiceStudio.*` 네임스페이스 신규.
- `frontend/src/lib/i18n/en.ts` — 동일.

### 1.3 변경하지 않는 자산

- 기존 `tts-voice/page.tsx`의 565줄 본문 — **배너 한 줄 삽입 외 무변경**.
- 기존 Header.tsx의 다른 5+ 아이콘 (Theme, Wiki, TTS Voice, Avatar Editor, Memory, Login) — 그대로.
- Sidebar.tsx — 무변경 (세션 리스트 전용).
- 백엔드 — 무변경.
- `ttsApi`, `VoiceProfile` 타입 — 무변경.

---

## 2. 구체 변경 명세

### 2.1 `frontend/src/components/Header.tsx`

라인 89-96 (TTS Voice Link) **뒤**에 Voice Studio Link 추가:

```tsx
{/* ── Voice Studio Button — hidden on mobile ── */}
<Link
  href="/voice-studio"
  className="hidden sm:flex items-center justify-center w-8 h-8 rounded-md bg-[var(--bg-tertiary)] border border-[var(--border-color)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] cursor-pointer transition-all duration-150 no-underline"
  title={t('header.voiceStudio')}
>
  <Sliders size={14} />
</Link>
```

import 라인에 `Sliders` 추가:
```tsx
import { Menu, Sun, Moon, Code2, User, BookOpen, AudioLines, Sliders, LogIn, LogOut, Brain, Layers, Palette } from 'lucide-react';
```

### 2.2 `frontend/src/app/voice-studio/layout.tsx` (신규)

```tsx
'use client';

import { ReactNode } from 'react';
import SideNav from '@/components/voice-studio/SideNav';
import { useI18n } from '@/lib/i18n';

export default function VoiceStudioLayout({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  return (
    <div className="flex h-screen bg-[var(--bg-primary)] text-[var(--text-primary)]">
      <SideNav />
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <div className="flex items-center h-14 px-4 md:px-6 border-b border-[var(--border-color)] bg-[var(--bg-secondary)] shrink-0">
          <h1 className="text-[0.9375rem] font-semibold">{t('voiceStudio.title')}</h1>
        </div>
        <div className="flex-1 overflow-y-auto">{children}</div>
      </main>
    </div>
  );
}
```

### 2.3 `frontend/src/app/voice-studio/page.tsx` (신규)

```tsx
import { redirect } from 'next/navigation';

export default function VoiceStudioEntry() {
  redirect('/voice-studio/clone-design');
}
```

### 2.4 `frontend/src/components/voice-studio/SideNav.tsx` (신규)

5메뉴 좌측 네비. 활성 탭 highlight (Next.js `usePathname` 사용).

```tsx
'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ArrowLeft, AudioLines, Library, ListChecks, Wrench, Settings } from 'lucide-react';
import { useI18n } from '@/lib/i18n';

const NAV_ITEMS = [
  { href: '/voice-studio/clone-design', key: 'cloneDesign', Icon: AudioLines },
  { href: '/voice-studio/voices',       key: 'voices',      Icon: Library },
  { href: '/voice-studio/batch',        key: 'batch',       Icon: ListChecks },
  { href: '/voice-studio/tools',        key: 'tools',       Icon: Wrench },
  { href: '/voice-studio/settings',     key: 'settings',    Icon: Settings },
] as const;

export default function SideNav() {
  const { t } = useI18n();
  const pathname = usePathname();
  return (
    <aside className="w-56 shrink-0 border-r border-[var(--border-color)] bg-[var(--bg-secondary)] flex flex-col">
      <div className="flex items-center h-14 px-4 border-b border-[var(--border-color)]">
        <Link href="/" className="flex items-center gap-1.5 text-[0.8125rem] text-[var(--text-muted)] hover:text-[var(--text-primary)] no-underline transition-colors">
          <ArrowLeft size={14} />
          {t('voiceStudio.backToApp')}
        </Link>
      </div>
      <nav className="flex-1 overflow-y-auto py-2">
        {NAV_ITEMS.map(({ href, key, Icon }) => {
          const active = pathname === href || pathname?.startsWith(href + '/');
          return (
            <Link
              key={href}
              href={href}
              className={`flex items-center gap-2 px-4 py-2.5 text-[0.8125rem] border-l-2 no-underline transition-colors duration-100 ${
                active
                  ? 'bg-[var(--primary-subtle)] text-[var(--primary-color)] border-[var(--primary-color)] font-medium'
                  : 'border-transparent text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
              }`}
            >
              <Icon size={14} className="shrink-0 opacity-80" />
              <span className="truncate">{t(`voiceStudio.nav.${key}`)}</span>
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
```

### 2.5 `frontend/src/app/voice-studio/voices/page.tsx` (신규, 실작동)

```tsx
'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { Mic, Search, Star, Plus } from 'lucide-react';
import { ttsApi, type VoiceProfile } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import VoiceCard from '@/components/voice-studio/VoiceCard';

type Filter = 'all' | 'templates' | 'mine';

export default function VoicesPage() {
  const { t } = useI18n();
  const [profiles, setProfiles] = useState<VoiceProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res = await ttsApi.listProfiles();
      setProfiles(res.profiles || []);
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return profiles.filter((p) => {
      if (filter === 'templates' && !p.is_template) return false;
      if (filter === 'mine' && p.is_template) return false;
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) ||
        (p.display_name || '').toLowerCase().includes(q) ||
        (p.language || '').toLowerCase().includes(q)
      );
    });
  }, [profiles, filter, query]);

  return (
    <div className="max-w-6xl mx-auto px-6 py-8 space-y-6">
      {/* Toolbar */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-[var(--border-color)] bg-[var(--bg-tertiary)] flex-1 min-w-[200px] max-w-md">
          <Search size={14} className="text-[var(--text-muted)] shrink-0" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('voiceStudio.voices.searchPlaceholder')}
            className="bg-transparent border-none outline-none text-[0.8125rem] flex-1 text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
          />
        </div>
        <div className="inline-flex items-center gap-0.5 p-0.5 rounded-md bg-[var(--bg-tertiary)] border border-[var(--border-color)]">
          {(['all', 'templates', 'mine'] as Filter[]).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-2.5 py-1 text-[0.6875rem] font-medium rounded transition-all duration-150 border-none cursor-pointer ${
                filter === f
                  ? 'bg-[var(--primary-color)] text-white shadow-sm'
                  : 'bg-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)]'
              }`}
            >
              {t(`voiceStudio.voices.filter.${f}`)}
            </button>
          ))}
        </div>
        <span className="text-[0.75rem] text-[var(--text-muted)] ml-auto">
          {t('voiceStudio.voices.count', { n: filtered.length })}
        </span>
      </div>

      {/* States */}
      {loading && (
        <p className="text-[0.875rem] text-[var(--text-muted)] py-8 text-center">{t('voiceStudio.voices.loading')}</p>
      )}
      {error && (
        <div className="px-4 py-2 rounded-lg text-[0.8125rem] bg-[rgba(239,68,68,0.1)] text-[var(--danger-color)] border border-[rgba(239,68,68,0.2)]">
          {error}
        </div>
      )}
      {!loading && !error && filtered.length === 0 && (
        <div className="py-12 flex flex-col items-center text-center gap-2 text-[var(--text-muted)]">
          <Mic size={28} className="opacity-40" />
          <p className="text-[0.875rem]">{t('voiceStudio.voices.empty')}</p>
        </div>
      )}

      {/* Grid */}
      {!loading && !error && filtered.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {filtered.map((p) => (
            <VoiceCard key={p.name} profile={p} onActivated={load} />
          ))}
        </div>
      )}
    </div>
  );
}
```

### 2.6 `frontend/src/components/voice-studio/VoiceCard.tsx` (신규)

```tsx
'use client';

import { useState, useCallback } from 'react';
import Link from 'next/link';
import { Star, Mic, Globe, ChevronRight } from 'lucide-react';
import { ttsApi, type VoiceProfile } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

export default function VoiceCard({ profile, onActivated }: { profile: VoiceProfile; onActivated: () => void }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const refCount = Object.keys(profile.has_refs || {}).length;

  const activate = useCallback(async () => {
    if (profile.active || busy) return;
    setBusy(true);
    try {
      await ttsApi.activateProfile(profile.name);
      onActivated();
    } catch {
      // silent — error handled at page level on next load
    } finally {
      setBusy(false);
    }
  }, [profile.name, profile.active, busy, onActivated]);

  return (
    <div className={`rounded-xl border p-3.5 transition-colors ${
      profile.active
        ? 'border-[rgba(34,197,94,0.3)] bg-[rgba(34,197,94,0.05)]'
        : 'border-[var(--border-color)] bg-[var(--bg-secondary)] hover:border-[var(--primary-color)]'
    }`}>
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-lg bg-[var(--bg-tertiary)] flex items-center justify-center shrink-0">
          <Mic size={16} className="text-[var(--text-muted)]" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <p className="text-[0.875rem] font-medium truncate">{profile.display_name || profile.name}</p>
            {profile.active && (
              <Star size={11} className="text-[var(--success-color)] shrink-0" fill="currentColor" />
            )}
          </div>
          <p className="text-[0.6875rem] text-[var(--text-muted)] truncate font-mono">{profile.name}</p>
          <div className="flex items-center gap-2 mt-1.5 text-[0.6875rem] text-[var(--text-muted)]">
            {profile.language && (
              <span className="inline-flex items-center gap-1">
                <Globe size={10} />
                {profile.language}
              </span>
            )}
            <span>{t('voiceStudio.voices.refCount', { n: refCount })}</span>
            {profile.is_template && (
              <span className="px-1.5 py-px rounded text-[0.625rem] bg-[var(--bg-tertiary)] text-[var(--text-secondary)] uppercase tracking-wide">
                {t('voiceStudio.voices.template')}
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 mt-3">
        <button
          onClick={activate}
          disabled={profile.active || busy}
          className="px-3 py-1.5 rounded-md text-[0.75rem] font-medium border border-[var(--border-color)] bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--primary-color)] hover:border-[var(--primary-color)] cursor-pointer transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {profile.active ? t('voiceStudio.voices.active') : t('voiceStudio.voices.activate')}
        </button>
        <Link
          href={{ pathname: '/voice-studio/clone-design', query: { profile: profile.name } }}
          className="ml-auto inline-flex items-center gap-1 text-[0.75rem] text-[var(--text-muted)] hover:text-[var(--primary-color)] no-underline transition-colors"
        >
          {t('voiceStudio.voices.openInDesign')}
          <ChevronRight size={12} />
        </Link>
      </div>
    </div>
  );
}
```

### 2.7 Placeholder pages (4)

`clone-design/page.tsx`, `batch/page.tsx`, `tools/page.tsx`, `settings/page.tsx` — 동일 패턴:

```tsx
'use client';
import { useI18n } from '@/lib/i18n';
export default function ClonedesignPage() {
  const { t } = useI18n();
  return (
    <div className="max-w-3xl mx-auto px-6 py-12 text-center">
      <h2 className="text-[1rem] font-semibold mb-2">{t('voiceStudio.placeholder.cloneDesign.title')}</h2>
      <p className="text-[0.875rem] text-[var(--text-muted)]">{t('voiceStudio.placeholder.cloneDesign.body')}</p>
    </div>
  );
}
```

(나머지 3개는 각각 `batch` / `tools` / `settings` 키로 동일 패턴.)

### 2.8 `frontend/src/components/voice-studio/StudioPromoBanner.tsx` (신규)

```tsx
'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Sparkles, X } from 'lucide-react';
import { useI18n } from '@/lib/i18n';

const DISMISS_KEY = 'dismissed.voice-studio-banner';

export default function StudioPromoBanner() {
  const { t } = useI18n();
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    setShow(localStorage.getItem(DISMISS_KEY) !== '1');
  }, []);

  if (!show) return null;

  return (
    <div className="mx-4 mt-3 flex items-center gap-3 px-4 py-2 rounded-lg border border-[rgba(59,130,246,0.25)] bg-[rgba(59,130,246,0.06)] text-[0.8125rem]">
      <Sparkles size={14} className="text-[var(--primary-color)] shrink-0" />
      <span className="flex-1 text-[var(--text-secondary)]">{t('ttsVoice.studioPromoBanner.title')}</span>
      <Link
        href="/voice-studio"
        className="px-2.5 py-1 rounded-md bg-[var(--primary-color)] text-white text-[0.75rem] font-medium no-underline hover:opacity-90 transition-opacity"
      >
        {t('ttsVoice.studioPromoBanner.cta')}
      </Link>
      <button
        onClick={() => {
          if (typeof window !== 'undefined') localStorage.setItem(DISMISS_KEY, '1');
          setShow(false);
        }}
        title={t('ttsVoice.studioPromoBanner.dismiss')}
        className="flex items-center justify-center w-6 h-6 rounded-md bg-transparent border-none text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer transition-colors"
      >
        <X size={12} />
      </button>
    </div>
  );
}
```

### 2.9 `frontend/src/app/tts-voice/page.tsx` — 배너 1줄 삽입

Toast block 위 (line ~180 부근) 또는 Top bar 바로 아래에 `<StudioPromoBanner />` 한 줄 추가:

```tsx
import StudioPromoBanner from '@/components/voice-studio/StudioPromoBanner';
// ...
<main className="flex-1 flex flex-col min-w-0">
  {/* Top bar */}
  <div className="flex items-center h-14 px-4 md:px-6 border-b ...">
    {/* ... */}
  </div>

  <StudioPromoBanner />   {/* ← 신규 한 줄 */}

  {/* Toast */}
  {msg && ( ... )}
```

(다른 565줄 본문은 무변경.)

### 2.10 `frontend/src/lib/voiceStudioApi.ts` (신규, placeholder)

```tsx
/**
 * Voice Studio API client.
 *
 * PR 1A baseline: empty placeholder. Existing `ttsApi` (in `./api.ts`)
 * already covers list/get/create/activate/upload-ref. New methods land
 * starting PR 1B (synth/preview, languages, engines, history, …).
 */
export const voiceStudioApi = {};
```

### 2.11 i18n 신규 키 (ko/en)

**`header` 네임스페이스에 추가**:
- ko: `voiceStudio: '보이스 스튜디오'`
- en: `voiceStudio: 'Voice Studio'`

**`ttsVoice` 네임스페이스에 `studioPromoBanner` 신규**:
- ko:
  ```ts
  studioPromoBanner: {
    title: '강화된 Voice Studio가 도착했습니다 — OmniVoice 풀 컨트롤 + 합성 미리듣기 + 일괄 처리',
    cta: '열기',
    dismiss: '닫기',
  }
  ```
- en:
  ```ts
  studioPromoBanner: {
    title: 'The upgraded Voice Studio is here — full OmniVoice controls, synthesis preview, batch jobs',
    cta: 'Open',
    dismiss: 'Dismiss',
  }
  ```

**신규 `voiceStudio` 네임스페이스**:
- ko:
  ```ts
  voiceStudio: {
    title: 'Voice Studio',
    backToApp: '메인으로',
    nav: {
      cloneDesign: '합성 · 디자인',
      voices: '보이스 프로필',
      batch: '배치 합성',
      tools: '도구',
      settings: '설정',
    },
    voices: {
      searchPlaceholder: '프로필 검색...',
      filter: { all: '전체', templates: '템플릿', mine: '내 프로필' },
      count: '{n}개',
      loading: '로딩 중...',
      empty: '표시할 프로필이 없습니다.',
      refCount: 'ref {n}개',
      template: '템플릿',
      active: '활성',
      activate: '활성 보이스로',
      openInDesign: 'Clone & Design',
    },
    placeholder: {
      cloneDesign: { title: '합성 · 디자인', body: 'OmniVoice 풀 파라미터 합성 카드는 PR 1B에서 도입됩니다.' },
      batch: { title: '배치 합성', body: 'CSV/JSON/텍스트 라인별 합성 + zip 다운로드는 Phase 4에서 도입됩니다.' },
      tools: { title: '도구', body: 'Seed search, language detect, A/B compare 등은 Phase 4에서 도입됩니다.' },
      settings: { title: '설정', body: '엔진 Compatibility Matrix + OmniVoice 디폴트 + 캐시 + HF token은 Phase 3에서 도입됩니다.' },
    },
  }
  ```
- en: 동일 구조, 영문.

---

## 3. 검증 절차

### 3.1 정적 검증

```bash
cd /home/geny-workspace/Geny/frontend

# 1) TypeScript 컴파일
bun run build 2>&1 | tail -30
# → 0 errors

# 2) tts-voice 페이지 코드 변경 최소 확인
git diff src/app/tts-voice/page.tsx | head -20
# → import 1줄 추가 + <StudioPromoBanner /> 1줄 추가만 보임

# 3) i18n 키 누락 검사 (런타임 fallback)
grep -E "voiceStudio\.|ttsVoice\.studioPromoBanner" src/lib/i18n/ko.ts | head -20
grep -E "voiceStudio\.|ttsVoice\.studioPromoBanner" src/lib/i18n/en.ts | head -20
```

### 3.2 런타임 검증 (수동)

- `/tts-voice` 진입 → 기존 UI + 상단 배너 표시 + 8 감정 카드 그대로 동작.
- 배너 "열기" 클릭 → `/voice-studio` → `/voice-studio/clone-design` redirect → placeholder 표시.
- 배너 X 클릭 → 사라짐 → `/tts-voice` 새로고침 후에도 안 보임 (localStorage `dismissed.voice-studio-banner=1`).
- Header의 Sliders 아이콘 클릭 → `/voice-studio` 이동.
- 좌측 SideNav 5메뉴 — clone-design / voices / batch / tools / settings 모두 클릭 → 각 페이지 렌더 + 활성 탭 highlight.
- `/voice-studio/voices` → 4 (또는 6) 템플릿 카드 표시 + 검색/필터 동작 + 1개 활성(별 표시).
- 카드의 "활성 보이스로" 클릭 → 백엔드 activate 호출 → `list_profiles` 응답에 active 갱신 → UI 별 이동.
- 카드의 "Clone & Design" 링크 → `/voice-studio/clone-design?profile=<name>` 이동 (PR 1A는 placeholder).
- 회귀: 에이전트 채팅 TTS 정상 동작 (백엔드 변경 0건이므로 당연).

---

## 4. 리스크

| 리스크 | 완화 |
|---|---|
| Next.js redirect()이 server component에서만 정상 — `voice-studio/page.tsx`에 'use client' 안 붙이면 OK | server-only entry로 작성 (위 §2.3 그대로) |
| `usePathname()`은 client only — SideNav가 'use client' 필요 | 명시 |
| localStorage SSR | `typeof window === 'undefined'` 가드 |
| i18n 키 누락 → 런타임에 키 그대로 렌더 | build 후 grep으로 누락 확인 |
| Header에 import 추가 시 lucide tree-shake 이슈 | 추가 import 한 줄, 영향 미미 |
| `tts-voice` 페이지 565줄 본문 회귀 | 배너 1줄만 삽입 + diff 확인으로 보장 |

---

## 5. PR 정보

- 브랜치: `feature/voice-studio-phase1a`
- 제목: `feat(voice-studio): scaffold /voice-studio + voices catalog + header entry`
- 본문 요지:
  - Voice Studio 라우팅 골격 (5탭) 도입.
  - `/voice-studio/voices` 1차 실작동 (프로필 카탈로그 + 활성화).
  - Header에 Voice Studio 아이콘 추가, `/tts-voice`는 배너로 안내 (병행 유지).
  - 다른 4탭은 placeholder, PR 1B 이후 본격 구현.

---

## 6. 다음 단계

PR 1A 머지 + 서버 배포 + 회귀 검증 → Phase 1B PLAN.md 작성 → Clone & Design 본격 구현.
