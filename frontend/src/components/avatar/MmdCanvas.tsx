'use client';

import { useEffect, useRef } from 'react';
import { useVTuberStore } from '@/store/useVTuberStore';
import { getAudioManager } from '@/lib/audioManager';
import type { Live2dModelInfo, MmdModelConfig } from '@/types';

/**
 * MmdCanvas — live 3D viewer for MMD (PMX/PMD) models via babylon-mmd.
 *
 * Phase 3D.1 of the MMD runtime. Third leg of the AvatarCanvas dispatch
 * next to Live2DCanvas and SpineCanvas. Unlike SpineCanvas (read-only
 * viewer), this one is a full VTuber surface:
 *
 *   - lip-sync: TTS amplitude (audioManager RMS callback — the exact
 *     same tap Live2D's enhancedLipSync uses) drives a mouth morph
 *   - emotion:  avatar_state WS pushes (emotion string) resolve to a
 *     morph via the model's emotionMorphMap (editor-authored) with a
 *     JP-standard-name heuristic fallback, eased over transition_ms
 *   - idle:     procedural blink + breathing sway so a motion-less
 *     model never looks frozen
 *   - physics:  bullet WASM (single-threaded build — no COOP/COEP
 *     requirement); hair/skirt sway. Init failure degrades to rigid.
 *
 * Assets load over plain HTTP from /static/mmd-models/** — PMX texture
 * paths are directory-relative and babylon-mmd resolves them against
 * the model URL (backslashes and case handled by its PathNormalize).
 *
 * The whole module (and the ~4MB babylon stack) loads only when a
 * session's assigned model has runtime === 'mmd' — AvatarCanvas pulls
 * it in via next/dynamic.
 */

// side-effect registrations: PMX/PMD loader plugin, MMD outline pass,
// TGA textures (MMD bundles commonly ship .tga)
import 'babylon-mmd/esm/Loader/pmxLoader';
import 'babylon-mmd/esm/Loader/pmdLoader';
import 'babylon-mmd/esm/Loader/mmdOutlineRenderer';
import '@babylonjs/core/Materials/Textures/Loaders/tgaTextureLoader';

import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { Engine } from '@babylonjs/core/Engines/engine';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { LoadAssetContainerAsync } from '@babylonjs/core/Loading/sceneLoader';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import { Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Scene } from '@babylonjs/core/scene';
import { MmdStandardMaterialBuilder } from 'babylon-mmd/esm/Loader/mmdStandardMaterialBuilder';
import { SdefInjector } from 'babylon-mmd/esm/Loader/sdefInjector';
import { MmdRuntime } from 'babylon-mmd/esm/Runtime/mmdRuntime';
import type { MmdModel } from 'babylon-mmd/esm/Runtime/mmdModel';

interface MmdCanvasProps {
  sessionId: string;
  model: Live2dModelInfo;
  className?: string;
  interactive?: boolean;
  /** kept for prop parity with the other canvases; 3D framing comes
   *  from mmdConfig.camera instead */
  background?: number;
  backgroundAlpha?: number;
}

/** Standard-name candidates for the lip-sync mouth morph, tried in
 *  order when the editor didn't pin one. 「あ」 is the de-facto MMD
 *  vowel-open morph every distributed model ships. */
const LIPSYNC_MORPHS = ['あ', 'あ2', 'a', 'A', '口開け'];

/** Blink morph candidates (idle driver). */
const BLINK_MORPHS = ['まばたき', '瞬き', 'まばたき両目', 'blink'];

/** Fallback emotion → morph-name candidates when the editor authored
 *  no emotionMorphMap. Matched against the model's actual morph list;
 *  first hit wins, no hit = neutral face for that emotion. */
const EMOTION_FALLBACK: Record<string, string[]> = {
  neutral: [],
  joy: ['笑い', 'にこり', '笑顔', 'にっこり'],
  anger: ['怒り', 'キリッ', '真面目'],
  disgust: ['じと目', '不機嫌'],
  fear: ['びっくり', '恐ろしい子！'],
  sadness: ['困る', '悲しい目', 'しょんぼり'],
  surprise: ['びっくり', '驚き'],
  smirk: ['ウィンク', 'にやり', 'ウィンク右'],
};

const BREATH_BONE = '上半身';
const HEAD_BONE = '頭';
const EYES_BONE = '両目';
const ARM_R_BONE = '右腕';
const ARM_L_BONE = '左腕';

/** T-pose → natural stance: rotate upper arms ~34° about Z so the model
 *  stands with arms at its sides instead of the frozen bind pose
 *  (+Z lowers the right arm, −Z the left — validated on a real PMX).
 *  Mirrors the editor's MmdStage; a playing VMD owns these bones. */
const ARM_DOWN_RAD = 0.6;

/** Backbuffer long-edge cap. A fullscreen overlay at dpr ≥ 1 otherwise
 *  allocates a 4K-class framebuffer; with SDEF skinning + the MMD
 *  outline second pass that's enough sustained GPU load to wedge weaker
 *  GPUs (reported as a frozen browser during camera interaction). */
const MAX_RENDER_EDGE_PX = 2048;

type BoneLike = { name: string; rotationQuaternion: Quaternion };

export default function MmdCanvas({
  sessionId,
  model,
  className = '',
  interactive = true,
}: MmdCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const avatarState = useVTuberStore((s) => s.avatarStates[sessionId]);
  const genRef = useRef(0);

  // Live handles the mount effect exposes to the state/lip-sync effects.
  const mmdModelRef = useRef<MmdModel | null>(null);
  const morphNamesRef = useRef<string[]>([]);
  // Per-frame morph easing targets: name → {target, ratePerMs}
  const morphTargetsRef = useRef<Map<string, { target: number; ms: number }>>(new Map());
  const activeEmotionMorphRef = useRef<string | null>(null);
  const lipSyncMorphRef = useRef<string | null>(null);
  const lipAmpRef = useRef(0);

  // ── Mount + load (re-runs when the assigned model changes) ────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !model?.url) return;
    const myGen = ++genRef.current;
    let cancelled = false;
    const disposers: (() => void)[] = [];

    (async () => {
      const canvas = document.createElement('canvas');
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      canvas.style.display = 'block';

      const engine = new Engine(canvas, true, {
        alpha: true,
        premultipliedAlpha: false,
        stencil: true,
        powerPreference: 'high-performance',
      });
      SdefInjector.OverrideEngineCreateEffect(engine);
      const scene = new Scene(engine);
      scene.clearColor = new Color4(0, 0, 0, 0); // overlay-transparent
      scene.ambientColor = new Color3(0.5, 0.5, 0.5);

      const camera = new ArcRotateCamera(
        'mmdCamera',
        -Math.PI / 2,
        Math.PI / 2,
        30,
        new Vector3(0, 12, 0),
        scene,
      );
      camera.minZ = 0.1;
      camera.maxZ = 500;
      camera.lowerRadiusLimit = 2;
      camera.upperRadiusLimit = 120;
      camera.wheelDeltaPercentage = 0.02;
      camera.panningSensibility = 60;

      const dir = new DirectionalLight('mmdDir', new Vector3(0.5, -1, 1), scene);
      dir.intensity = 0.8;
      const hemi = new HemisphericLight('mmdHemi', new Vector3(0, 1, 0), scene);
      hemi.intensity = 0.4;

      const teardown = () => {
        try {
          scene.dispose();
          engine.dispose();
        } catch {
          /* double-dispose race on fast remount — harmless */
        }
        canvas.remove();
      };

      try {
        const container3d = await LoadAssetContainerAsync(model.url, scene, {
          pluginOptions: {
            mmdmodel: {
              materialBuilder: new MmdStandardMaterialBuilder(),
              loggingEnabled: false,
            },
          },
        });
        if (cancelled || myGen !== genRef.current) {
          teardown();
          return;
        }
        container3d.addAllToScene();

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rootMesh = container3d.meshes[0] as any;
        const metadata = rootMesh.metadata ?? {};
        const meshes = [...(metadata.meshes ?? [])];
        const materials = [...(metadata.materials ?? [])];
        const skeletonBones: BoneLike[] = metadata.skeleton?.bones ?? [];
        const morphNames: string[] = (metadata.morphs ?? [])
          .map((m: { name?: string }) => m?.name)
          .filter(Boolean);
        morphNamesRef.current = morphNames;

        const cfg: MmdModelConfig = model.mmdConfig ?? {};

        // Editor-hidden materials (indices are exact; names are the
        // human-readable duplicate — indices win when present).
        const hiddenIdx = new Set(cfg.hiddenMaterialIndices ?? []);
        if (hiddenIdx.size === 0 && (cfg.hiddenMaterials?.length ?? 0) > 0) {
          const wanted = new Set(cfg.hiddenMaterials);
          materials.forEach((mat: { name: string }, i: number) => {
            if (wanted.has(mat.name)) hiddenIdx.add(i);
          });
        }
        if (meshes.length === materials.length) {
          for (const i of hiddenIdx) meshes[i]?.setEnabled(false);
        }

        // Physics — optional; single-threaded WASM build.
        let physicsOk = false;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let physics: any = null;
        try {
          const [
            { GetMmdWasmInstance },
            { MmdWasmInstanceTypeSPR },
            { MultiPhysicsRuntime },
            { MmdBulletPhysics },
          ] = await Promise.all([
            import('babylon-mmd/esm/Runtime/Optimized/mmdWasmInstance'),
            import('babylon-mmd/esm/Runtime/Optimized/InstanceType/singlePhysicsRelease'),
            import('babylon-mmd/esm/Runtime/Optimized/Physics/Bind/Impl/multiPhysicsRuntime'),
            import('babylon-mmd/esm/Runtime/Optimized/Physics/mmdBulletPhysics'),
          ]);
          if (cancelled || myGen !== genRef.current) {
            teardown();
            return;
          }
          const wasmInstance = await GetMmdWasmInstance(new MmdWasmInstanceTypeSPR());
          const physicsRuntime = new MultiPhysicsRuntime(wasmInstance);
          physicsRuntime.setGravity(new Vector3(0, -98, 0));
          physicsRuntime.register(scene);
          disposers.push(() => physicsRuntime.dispose());
          physics = new MmdBulletPhysics(physicsRuntime);
          physicsOk = true;
        } catch (e) {
          console.warn('[MmdCanvas] physics unavailable — rigid fallback', e);
        }
        if (cancelled || myGen !== genRef.current) {
          teardown();
          return;
        }

        const mmdRuntime = new MmdRuntime(scene, physics);
        mmdRuntime.register(scene);
        const mmdModel = mmdRuntime.createMmdModel(rootMesh, { buildPhysics: physicsOk });
        mmdModelRef.current = mmdModel;

        // Camera: editor-saved pose wins; otherwise frame from bounds.
        const pose = cfg.camera;
        if (pose) {
          camera.alpha = pose.alpha;
          camera.beta = pose.beta;
          camera.radius = pose.radius;
          camera.setTarget(new Vector3(pose.targetX, pose.targetY, pose.targetZ));
        } else {
          const bb = rootMesh.getHierarchyBoundingVectors();
          const height = Math.max(bb.max.y - Math.max(bb.min.y, 0), 1);
          camera.radius = Math.min(Math.max(height * 1.15, 8), 110);
          camera.setTarget(new Vector3(0, Math.max(bb.min.y, 0) + height * 0.65, 0));
        }
        if (interactive) camera.attachControl(canvas, false);

        // Lip-sync morph: editor-pinned → standard names → any mouth
        // morph from the sidecar catalog.
        const catalogMouth = (cfg.morphs ?? []).find((m) => m.panel === 'mouth')?.name;
        lipSyncMorphRef.current =
          (cfg.lipSyncMorph && morphNames.includes(cfg.lipSyncMorph) ? cfg.lipSyncMorph : null) ??
          LIPSYNC_MORPHS.find((n) => morphNames.includes(n)) ??
          (catalogMouth && morphNames.includes(catalogMouth) ? catalogMouth : null);

        const blinkMorph = BLINK_MORPHS.find((n) => morphNames.includes(n)) ?? null;

        // ── per-frame driver: morph easing + lip-sync + idle ──
        const boneByName = (name: string) => skeletonBones.find((b) => b.name === name) ?? null;
        const breathBone = boneByName(BREATH_BONE);
        const headBone = boneByName(HEAD_BONE);
        const eyesBone = boneByName(EYES_BONE);
        const armR = boneByName(ARM_R_BONE);
        const armL = boneByName(ARM_L_BONE);
        const restOf = (b: BoneLike | null) => (b ? b.rotationQuaternion.clone() : null);
        const breathRest = restOf(breathBone);
        const headRest = restOf(headBone);
        const eyesRest = restOf(eyesBone);
        const armRRest = restOf(armR);
        const armLRest = restOf(armL);
        const tmpQ = new Quaternion();
        const outQ = new Quaternion();

        let nextBlinkAt = performance.now() + 2000;
        let blinkPhase = -1;
        const BLINK_MS = 170;
        let lipWeight = 0;
        // gaze wander — small saccades every 2–5s, eased over ~120ms
        let gazeYaw = 0;
        let gazeTargetYaw = 0;
        let nextSaccadeAt = performance.now() + 2200;

        const beforeRender = scene.onBeforeRenderObservable.add(() => {
          const now = performance.now();
          const dt = engine.getDeltaTime();

          // emotion morph easing toward targets — move a constant
          // full-range fraction per ms so a transition_ms of 300 takes
          // ~300ms regardless of starting weight, without overshoot.
          for (const [name, t] of morphTargetsRef.current) {
            const cur = safeGetMorph(mmdModel, name);
            const maxStep = t.ms > 0 ? dt / t.ms : 1;
            const delta = t.target - cur;
            const next = cur + Math.sign(delta) * Math.min(Math.abs(delta), maxStep);
            safeSetMorph(mmdModel, name, next);
            if (Math.abs(next - t.target) < 0.001) {
              safeSetMorph(mmdModel, name, t.target);
              morphTargetsRef.current.delete(name);
            }
          }

          // lip-sync: RMS amplitude → smoothed mouth-open weight
          const lipMorph = lipSyncMorphRef.current;
          if (lipMorph) {
            const target = Math.min(1, lipAmpRef.current * 7);
            lipWeight += (target - lipWeight) * Math.min(1, dt / 60);
            safeSetMorph(mmdModel, lipMorph, lipWeight < 0.01 ? 0 : lipWeight);
          }

          // idle: layered natural stance + breath + sway + gaze
          const breath = Math.sin(((now % 4000) / 4000) * Math.PI * 2); // 4s
          const sway = Math.sin(((now % 7300) / 7300) * Math.PI * 2); // 7.3s

          // arms — rest-down pose + breath-synced drift
          const armDrift = breath * 0.012;
          if (armR && armRRest) {
            Quaternion.RotationYawPitchRollToRef(0, 0, ARM_DOWN_RAD + armDrift, tmpQ);
            armRRest.multiplyToRef(tmpQ, outQ);
            armR.rotationQuaternion = outQ;
          }
          if (armL && armLRest) {
            Quaternion.RotationYawPitchRollToRef(0, 0, -(ARM_DOWN_RAD + armDrift), tmpQ);
            armLRest.multiplyToRef(tmpQ, outQ);
            armL.rotationQuaternion = outQ;
          }
          if (breathBone && breathRest) {
            Quaternion.RotationYawPitchRollToRef(sway * 0.012, breath * 0.025, 0, tmpQ);
            breathRest.multiplyToRef(tmpQ, outQ);
            breathBone.rotationQuaternion = outQ;
          }
          if (headBone && headRest) {
            Quaternion.RotationYawPitchRollToRef(-sway * 0.008, -breath * 0.012, 0, tmpQ);
            headRest.multiplyToRef(tmpQ, outQ);
            headBone.rotationQuaternion = outQ;
          }
          if (eyesBone && eyesRest) {
            if (now >= nextSaccadeAt) {
              gazeTargetYaw = (Math.random() - 0.5) * 0.09;
              nextSaccadeAt = now + 2000 + Math.random() * 3000;
            }
            gazeYaw += (gazeTargetYaw - gazeYaw) * Math.min(1, dt / 120);
            Quaternion.RotationYawPitchRollToRef(gazeYaw, 0, 0, tmpQ);
            eyesRest.multiplyToRef(tmpQ, outQ);
            eyesBone.rotationQuaternion = outQ;
          }

          // idle: blink
          if (!blinkMorph) return;
          if (blinkPhase < 0) {
            if (now >= nextBlinkAt) blinkPhase = 0;
            else return;
          }
          blinkPhase = Math.min(1, blinkPhase + dt / BLINK_MS);
          const w = blinkPhase < 0.5 ? blinkPhase * 2 : (1 - blinkPhase) * 2;
          safeSetMorph(mmdModel, blinkMorph, w);
          if (blinkPhase >= 1) {
            blinkPhase = -1;
            nextBlinkAt = now + 2500 + Math.random() * 3500;
            safeSetMorph(mmdModel, blinkMorph, 0);
          }
        });
        disposers.push(() => scene.onBeforeRenderObservable.remove(beforeRender));

        // lip-sync amplitude tap — same singleton slot Live2D uses; the
        // dispatcher mounts exactly one avatar canvas per session view.
        const audioManager = getAudioManager();
        audioManager.setAmplitudeCallback((amp: number) => {
          lipAmpRef.current = amp;
        });
        disposers.push(() => {
          lipAmpRef.current = 0;
        });

        container.appendChild(canvas);
        // native-dpr sharpness, but cap the backbuffer long edge (see
        // MAX_RENDER_EDGE_PX) so fullscreen overlays don't allocate a
        // 4K-class framebuffer on high-res displays.
        const updateScaling = () => {
          const dpr = window.devicePixelRatio || 1;
          const longEdgeCss = Math.max(canvas.clientWidth, canvas.clientHeight, 1);
          engine.setHardwareScalingLevel(Math.max(1 / dpr, longEdgeCss / MAX_RENDER_EDGE_PX));
          engine.resize();
        };
        const resize = new ResizeObserver(updateScaling);
        resize.observe(container);
        disposers.push(() => resize.disconnect());
        updateScaling();

        engine.runRenderLoop(() => scene.render());
        console.log(
          `[MmdCanvas] loaded ${model.name} · morphs=${morphNames.length} ` +
            `physics=${physicsOk} lipSync=${lipSyncMorphRef.current ?? '(none)'}`,
        );
      } catch (e) {
        console.error('[MmdCanvas] model load failed:', model.url, e);
        teardown();
        return;
      }

      // one teardown for the whole successful mount
      disposers.push(teardown);
    })();

    return () => {
      cancelled = true;
      genRef.current++;
      mmdModelRef.current = null;
      morphTargetsRef.current.clear();
      activeEmotionMorphRef.current = null;
      for (const d of disposers.reverse()) {
        try {
          d();
        } catch {
          /* teardown best-effort */
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model?.name, model?.url]);

  // ── Apply avatar state (emotion → morph, eased) ───────────────────
  useEffect(() => {
    if (!avatarState || !mmdModelRef.current) return;
    const morphNames = morphNamesRef.current;
    const cfg: MmdModelConfig = model.mmdConfig ?? {};
    const ms = Math.max(0, avatarState.transition_ms || 300);
    const intensity = Math.min(1, Math.max(0, avatarState.intensity ?? 1));

    // Resolve emotion → morph name: editor map first, fallback table next.
    let morph: string | null = cfg.emotionMorphMap?.[avatarState.emotion] ?? null;
    if (morph && !morphNames.includes(morph)) morph = null;
    if (!morph) {
      morph =
        (EMOTION_FALLBACK[avatarState.emotion] ?? []).find((n) => morphNames.includes(n)) ?? null;
    }

    const prev = activeEmotionMorphRef.current;
    if (prev && prev !== morph) {
      morphTargetsRef.current.set(prev, { target: 0, ms });
    }
    if (morph) {
      morphTargetsRef.current.set(morph, { target: intensity, ms });
    }
    activeEmotionMorphRef.current = morph;
  }, [avatarState, model.mmdConfig]);

  return <div ref={containerRef} className={`h-full w-full ${className}`} />;
}

// Morph names come from user files — guard every runtime call so a
// mid-teardown or bad name never throws into React's render cycle.
function safeSetMorph(m: MmdModel, name: string, w: number): void {
  try {
    m.morph.setMorphWeight(name, w);
  } catch {
    /* unknown morph / disposed runtime */
  }
}

function safeGetMorph(m: MmdModel, name: string): number {
  try {
    return m.morph.getMorphWeight(name);
  } catch {
    return 0;
  }
}
