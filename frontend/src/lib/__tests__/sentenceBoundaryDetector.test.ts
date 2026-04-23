/**
 * Unit tests for sentenceBoundaryDetector.
 *
 * 실행:  cd Geny/frontend && npx vitest run src/lib/__tests__/sentenceBoundaryDetector.test.ts
 */

import { describe, it, expect } from 'vitest';
import {
  extractCompletedSentences,
  SentenceStreamExtractor,
} from '../sentenceBoundaryDetector';

describe('extractCompletedSentences', () => {
  it('splits simple English sentences', () => {
    const r = extractCompletedSentences('Hello world. How are you? Fine!', '');
    expect(r.sentences).toEqual(['Hello world.', 'How are you?', 'Fine!']);
    expect(r.remainder).toBe('');
  });

  it('preserves incomplete trailing fragment', () => {
    const r = extractCompletedSentences('Hello. Partial tex', '');
    expect(r.sentences).toEqual(['Hello.']);
    expect(r.remainder).toBe('Partial tex');
  });

  it('splits Korean sentences with 요/다/요?', () => {
    const r = extractCompletedSentences('안녕하세요. 반갑습니다! 잘 지내요?', '');
    expect(r.sentences).toEqual(['안녕하세요.', '반갑습니다!', '잘 지내요?']);
  });

  it('handles paragraph break as forced boundary', () => {
    const r = extractCompletedSentences('First line\n\nSecond line start', '');
    expect(r.sentences).toEqual(['First line']);
    // 두 번째 줄은 종결부호 없어 remainder 에 남아야 함
    expect(r.remainder).toBe('Second line start');
  });

  it('forceFinal includes remainder', () => {
    const r = extractCompletedSentences('Tail without period', '', { forceFinal: true });
    expect(r.sentences).toEqual(['Tail without period']);
    expect(r.remainder).toBe('');
  });

  it('honours prevEmitted prefix — no duplicates', () => {
    const full = 'First sentence. Second sentence. Third.';
    const r = extractCompletedSentences(full, 'First sentence. ');
    expect(r.sentences).toEqual(['Second sentence.', 'Third.']);
  });

  it('handles quoted endings', () => {
    const r = extractCompletedSentences('He said "hello." She replied.', '');
    expect(r.sentences.length).toBe(2);
    expect(r.sentences[0]).toContain('hello.');
  });

  it('is idempotent when nothing new', () => {
    const r = extractCompletedSentences('Done.', 'Done.');
    expect(r.sentences).toEqual([]);
    expect(r.remainder).toBe('');
  });
});

describe('SentenceStreamExtractor', () => {
  it('accumulates across pushes without duplicates', () => {
    const ex = new SentenceStreamExtractor();
    expect(ex.push('k', 'Hello w')).toEqual([]);
    expect(ex.push('k', 'Hello world. ')).toEqual(['Hello world.']);
    // 다시 같은 텍스트를 push 해도 중복 없음
    expect(ex.push('k', 'Hello world. ')).toEqual([]);
    expect(ex.push('k', 'Hello world. Second.')).toEqual(['Second.']);
  });

  it('flush emits tail when final', () => {
    const ex = new SentenceStreamExtractor();
    ex.push('k', 'Alpha. Bet');
    expect(ex.flush('k', 'Alpha. Beta tail')).toEqual(['Beta tail']);
  });

  it('keys are independent', () => {
    const ex = new SentenceStreamExtractor();
    ex.push('a', 'One.');
    ex.push('b', 'Two.');
    // 다른 키는 서로 영향 X
    expect(ex.push('a', 'One. Three.')).toEqual(['Three.']);
    expect(ex.push('b', 'Two. Four.')).toEqual(['Four.']);
  });

  it('coalesces short sentences when minChars is set', () => {
    const ex = new SentenceStreamExtractor({ minChars: 20 });
    // 짧은 문장 3개 (각 5/8/10자) — 합쳐야 minChars 충족
    expect(ex.push('k', 'Hi! ')).toEqual([]); // 3자 → hold
    expect(ex.push('k', 'Hi! Hello. ')).toEqual([]); // 3+6=9자 → hold
    expect(ex.push('k', 'Hi! Hello. World peace? ')).toEqual([
      'Hi! Hello. World peace?',
    ]); // 9+13=22자 ≥ 20 → emit
  });

  it('does not coalesce when sentence already ≥ minChars', () => {
    const ex = new SentenceStreamExtractor({ minChars: 10 });
    expect(ex.push('k', 'This is a long sentence.')).toEqual([
      'This is a long sentence.',
    ]);
  });

  it('flush emits short holding tail even below minChars', () => {
    const ex = new SentenceStreamExtractor({ minChars: 50 });
    ex.push('k', 'Short. ');
    // 6자 < 50 이지만 flush 시 강제 emit
    expect(ex.flush('k', 'Short. Tail')).toEqual(['Short. Tail']);
  });

  it('reset clears holding too', () => {
    const ex = new SentenceStreamExtractor({ minChars: 20 });
    ex.push('k', 'Hi. ');
    ex.reset('k');
    // reset 후에는 holding 도 비어있어야 새 문장만 emit
    expect(ex.push('k', 'Long enough sentence.')).toEqual(['Long enough sentence.']);
  });
});
