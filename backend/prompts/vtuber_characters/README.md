# VTuber Character Prompts

이 디렉토리에는 Live2D 모델별 캐릭터 프롬프트 파일이 저장됩니다.

## 사용법

파일 이름은 `model_registry.json`의 모델 `name` 필드와 일치해야 합니다.

예: 모델 이름이 `mao_pro`이면 → `mao_pro.md` 파일을 생성합니다.

해당 모델 파일이 없으면 `default.md`가 사용됩니다.

## 파일 구성

```markdown
## Character Personality

캐릭터의 성격 및 특성을 서술합니다.

### Traits
- 성격 특성 1
- 성격 특성 2

### Speech Style
- 말투 특성
```
