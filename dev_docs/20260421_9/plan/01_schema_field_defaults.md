# Plan 01 — Schema field defaults 정당성

**작성일.** 2026-04-21

## 1. Vitals 기본값

```
hunger:      50.0   (0=포만, 100=굶주림)   — 중간값에서 시작
energy:      80.0   (0=탈진, 100=최상)     — 탄생 직후 활기차게
stress:      20.0   (0=평온, 100=극심)     — 약한 흥분 상태
cleanliness: 80.0   (0=더러움, 100=깨끗)    — 깨끗하게 태어남
```

- 전부 중앙/낙관 편향으로 초기화 — 신규 캐릭터가 "즉시 돌봄 필요" 로 보이지 않게.
- decay 시간상수 (plan/02 §5.2) 를 고려하면 약 40시간 방치 시 hunger 가 100 근처.

## 2. Bond 기본값

전부 `0.0`. 관계는 상호작용으로만 쌓인다. **decay 없음** — 한 번 쌓은 친밀도는 내려가지 않는다 (plan/02 §5.2).

## 3. Progression 기본값

```
age_days:     0
life_stage:   "infant"
xp:           0
milestones:   []
manifest_id:  "base"
```

- X4 의 ManifestSelector 가 character.manifest_id 를 읽어 첫 hydrate 때 이 값을 덮어쓸 수 있으나 PR-X3-1 스키마 측면에서는 "base" 를 안전한 default 로 둔다.

## 4. MoodVector 기본값

```
joy: 0.0  sadness: 0.0  anger: 0.0  fear: 0.0  excitement: 0.0
calm: 0.5   ← 유일한 비영값
```

- calm 이 0.5 인 이유: 다른 감정이 모두 0 이어도 "차분한" 이 중립 상태를 대변. 완전 무감정이 "calm=0" 이 아니라 "calm≈0.5" 로 읽히도록.
- `dominant()` 가 neutral 을 반환하려면 모든 basic 감정이 임계값 아래일 때 "calm" 을 기본 키워드로 쓴다.

## 5. CreatureState 메타 기본값

- `last_tick_at`: `datetime.now(timezone.utc)` — 생성 순간. 첫 decay tick 은 여기서 측정 시작.
- `last_interaction_at`: `None` — 아직 상호작용 없음.
- `recent_events`: `[]` — 링 버퍼, 최대 20 (상한은 mutation apply 시점에서 강제).
- `schema_version`: `SCHEMA_VERSION` (현재 1).

## 6. Mutation 기본값

- `at`: `datetime.now(timezone.utc)` — append 시점에 서버 시계.
- `note`: `None`. 디버깅용 optional.

## 7. 리스크

- **초기값 부작용.** energy=80 은 "잘 자고 일어남" 이 아니라 "생기 있음" 정도. decay 시간상수가 -1.5/hr 이므로 약 53시간 후 0 도달. 유저가 빠르게 지친 인상을 받지 않게 PR-X3-4 실제 측정 후 조정 가능.
- **bond=0 에서의 첫 인상.** affection 이 0 인 상태에서 LLM 은 어떻게 반응해야 하나. 이는 persona / manifest 의 문제 (X4 의 infant manifest 가 "겁이 많음" 으로 표현). PR-X3-1 스키마 측면 이슈는 아님.

## 8. 버전 정책

- `SCHEMA_VERSION = 1`. 필드 추가/제거 시 `migration/v1_to_v2.py` 같은 업그레이드 hook 으로 처리 (plan/02 §7). 본 PR-X3-1 은 buck stops here — v1 만 정의.
