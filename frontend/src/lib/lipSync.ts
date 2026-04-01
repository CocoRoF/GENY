/**
 * LipSyncController — Web Audio 진폭 → Live2D ParamMouthOpenY 매핑
 *
 * 책임:
 *  - AudioManager amplitude 콜백 수신
 *  - 지수 이동 평균 스무딩 (smoothing factor 0.3)
 *  - threshold 아래면 입 닫기
 *  - Live2D 모델의 ParamMouthOpenY 파라미터 제어
 */

const SMOOTHING = 0.3;
const MOUTH_OPEN_SCALE = 1.8;
const THRESHOLD = 0.015;

export class LipSyncController {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private model: any = null; // Live2D model reference
  private smoothValue = 0;

  /** Live2D 모델 연결 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setModel(model: any): void {
    this.model = model;
  }

  /**
   * AudioManager에서 호출하는 콜백
   * amplitude: 0.0 ~ 1.0 (RMS)
   */
  onAmplitude = (amplitude: number): void => {
    // 지수 이동 평균 스무딩
    this.smoothValue = SMOOTHING * this.smoothValue + (1 - SMOOTHING) * amplitude;

    if (!this.model?.internalModel?.coreModel) return;

    const coreModel = this.model.internalModel.coreModel;
    const mouthOpen =
      this.smoothValue > THRESHOLD
        ? Math.min(this.smoothValue * MOUTH_OPEN_SCALE, 1.0)
        : 0;

    coreModel.setParameterValueById('ParamMouthOpenY', mouthOpen);
  };

  /** 리셋 (재생 종료 시) */
  reset(): void {
    this.smoothValue = 0;
    if (this.model?.internalModel?.coreModel) {
      this.model.internalModel.coreModel.setParameterValueById('ParamMouthOpenY', 0);
    }
  }
}
