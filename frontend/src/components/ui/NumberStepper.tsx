'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from 'react';
import { twMerge } from 'tailwind-merge';

function cn(...classes: (string | boolean | undefined | null)[]) {
  return twMerge(classes.filter(Boolean).join(' '));
}

interface Props {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
}

/* ── Shared Tailwind strings ── */
const WRAP =
  'flex flex-row items-stretch h-[42px] border border-[var(--border-subtle)] rounded-[6px] overflow-hidden bg-[var(--bg-secondary)] transition-all duration-150 focus-within:border-[var(--primary-color)] focus-within:shadow-[0_0_0_3px_rgba(59,130,246,0.15)]';

const BTN =
  'flex items-center justify-center w-[38px] min-w-[38px] h-full border-none bg-transparent text-[var(--text-muted)] cursor-pointer transition-all duration-[120ms] p-0 m-0 shrink-0 leading-none hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] active:bg-[var(--primary-color)] active:text-white';

const BTN_DISABLED = 'opacity-25 !cursor-not-allowed';

const VALUE =
  'flex-1 min-w-0 w-auto border-none bg-transparent text-center text-[0.875rem] font-semibold tabular-nums text-[var(--text-primary)] p-0 px-1 m-0 rounded-none shadow-none outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none';


/**
 * NumberStepper — 숫자 입력 + ▲▼ 버튼.
 *
 * 핵심 UX 결정 (이전 버전의 회귀 fix):
 *
 *  - **타이핑 중에는 clamp 하지 않는다.** 사용자가 600 → 1200 으로 바꾸려고
 *    "1" 만 처음 타이핑한 순간 clamp(1)=min 이 즉시 commit 되면, 다음 타이핑이
 *    이미 새 base 위에서 일어나 의도한 1200 까지 못 도달한다. 이전 구현이
 *    이 문제 — 매 keystroke 마다 ``onChange(clamp(parseInt(raw)))`` 호출.
 *
 *  - **commit 시점은 blur 또는 Enter.** 그때만 clamp 후 부모에 최종값을 push.
 *    중간 타이핑 값은 부모에도 raw 정수 그대로 전달 (저장 가능한 형태로) —
 *    그래야 외부에서 controlled 패턴으로 ``value`` 를 그리는 caller 도
 *    실시간 입력을 볼 수 있다.
 *
 *  - **빈 입력 허용.** 비웠을 때는 부모에 push 하지 않고 (NaN 방지) 로컬 텍스트만
 *    빈 상태로 둔다. blur 시 빈 상태면 직전 commit 값으로 fallback.
 *
 *  - **부모 driven 변경은 동기화.** Reset / 외부 reload 등으로 부모 ``value`` 가
 *    바뀌면, focus 가 우리 input 에 없을 때만 로컬 텍스트를 갱신.
 *
 *  - **±버튼은 즉시 clamp.** 버튼 클릭은 사용자의 명시적 단계 입력이므로 typing
 *    UX 문제와 무관. hold-to-repeat 도 그대로 유지.
 *
 *  - **키보드: Enter = commit & blur, ↑/↓ = step.**
 */
export default function NumberStepper({
  value,
  onChange,
  min = 1,
  max = 9999,
  step = 1,
}: Props) {
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const valueRef = useRef(value);
  valueRef.current = value;

  // 로컬 입력 텍스트 — 타이핑 중 raw 표시. 부모 ``value`` 와 분리해두므로
  // clamp / NaN 강제 변환이 사용자 입력을 도중에 망가뜨리지 않는다.
  const [text, setText] = useState<string>(String(value));
  const [focused, setFocused] = useState(false);

  const clamp = useCallback(
    (v: number) => Math.min(max, Math.max(min, v)),
    [min, max],
  );

  // 외부 (부모 / reset 등) 에서 value 가 바뀌면 텍스트 동기화 — 단, 사용자가
  // 입력 중일 때는 덮어쓰지 않는다 (focused 가 false 일 때만).
  useEffect(() => {
    if (!focused) {
      setText(String(value));
    }
  }, [value, focused]);

  const stopRepeat = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  useEffect(() => stopRepeat, [stopRepeat]);

  const stepBy = useCallback(
    (delta: number) => {
      const next = clamp(valueRef.current + delta);
      valueRef.current = next;
      onChange(next);
      // focused 일 때 useEffect 가 sync 안 하므로 명시적으로 텍스트도 갱신.
      setText(String(next));
    },
    [clamp, onChange],
  );

  const startRepeat = useCallback(
    (delta: number) => {
      stepBy(delta);
      timeoutRef.current = setTimeout(() => {
        intervalRef.current = setInterval(() => stepBy(delta), 75);
      }, 400);
    },
    [stepBy],
  );

  // ── 입력 처리 ─────────────────────────────────────────────────

  const handleChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const raw = e.target.value;
      // 허용 패턴: 빈 문자열, 선택적 '-', 숫자. 그 외엔 무시 (이전 텍스트 유지).
      if (raw !== '' && raw !== '-' && !/^-?\d+$/.test(raw)) {
        return;
      }
      setText(raw);
      // 빈 / '-' 만 있는 중간 상태는 부모에 push 하지 않음 — NaN 방지.
      if (raw === '' || raw === '-') return;
      const parsed = parseInt(raw, 10);
      if (Number.isNaN(parsed)) return;
      // 핵심: 타이핑 중에는 clamp 하지 않는다. 부모는 raw 값을 받아 저장.
      // 최종 clamp 는 blur 시점에 한 번만 수행.
      if (parsed !== valueRef.current) {
        onChange(parsed);
      }
    },
    [onChange],
  );

  const commit = useCallback(() => {
    // 빈 / 잘못된 입력은 부모의 마지막 정상 value 로 fallback.
    if (text === '' || text === '-') {
      const fallback = clamp(valueRef.current);
      setText(String(fallback));
      if (fallback !== valueRef.current) onChange(fallback);
      return;
    }
    const parsed = parseInt(text, 10);
    if (Number.isNaN(parsed)) {
      const fallback = clamp(valueRef.current);
      setText(String(fallback));
      if (fallback !== valueRef.current) onChange(fallback);
      return;
    }
    const final = clamp(parsed);
    setText(String(final));
    if (final !== valueRef.current) onChange(final);
  }, [text, clamp, onChange]);

  const handleBlur = useCallback(() => {
    setFocused(false);
    commit();
  }, [commit]);

  const handleFocus = useCallback(() => {
    setFocused(true);
  }, []);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
        e.currentTarget.blur();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        // 입력 도중 취소 — 부모의 현재 value 로 되돌림.
        setText(String(valueRef.current));
        e.currentTarget.blur();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        stepBy(step);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        stepBy(-step);
      }
    },
    [commit, stepBy, step],
  );

  const atMin = value <= min;
  const atMax = value >= max;

  return (
    <div className={WRAP}>
      <button
        type="button"
        className={cn(
          BTN,
          'border-r border-r-[var(--border-subtle)] rounded-l-[6px]',
          atMin && BTN_DISABLED,
        )}
        disabled={atMin}
        onMouseDown={() => startRepeat(-step)}
        onMouseUp={stopRepeat}
        onMouseLeave={stopRepeat}
        tabIndex={-1}
        aria-label="Decrease"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path d="M2.5 6h7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>

      <input
        type="text"
        inputMode="numeric"
        className={VALUE}
        value={text}
        onChange={handleChange}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
      />

      <button
        type="button"
        className={cn(
          BTN,
          'border-l border-l-[var(--border-subtle)] rounded-r-[6px]',
          atMax && BTN_DISABLED,
        )}
        disabled={atMax}
        onMouseDown={() => startRepeat(step)}
        onMouseUp={stopRepeat}
        onMouseLeave={stopRepeat}
        tabIndex={-1}
        aria-label="Increase"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path
            d="M6 2.5v7M2.5 6h7"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </svg>
      </button>
    </div>
  );
}
