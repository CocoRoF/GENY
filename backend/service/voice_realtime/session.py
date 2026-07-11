"""RealtimeVoiceSession — the asyncio orchestrator for one voice call.

Owns one user's realtime turn loop. Reuses Geny's existing services
end-to-end; the only new logic is turn-taking + barge-in, rewritten
from the reference ``speech-to-speech`` CancelScope pattern in Geny's
asyncio idiom.

Per turn:
  1. transcribe(utterance)  → whisper_client            → emit transcript
  2. execute_command(...)   fired as a task (persona/memory/tools intact)
  3. poll STREAM logs       → EmotionExtractor + sentence extractor
  4. per sentence           → tts_service.speak_sentences → emit audio
  5. barge-in               → stop_execution + generation bump + flush

The WebSocket layer (:mod:`ws.voice_realtime_stream`) feeds this class
inbound events and forwards the ``emit`` callbacks to the socket.
"""

from __future__ import annotations

import asyncio
import base64
from logging import getLogger
from typing import Awaitable, Callable, Dict, Optional

from . import config as _cfg

logger = getLogger(__name__)

# Fallback emotion→expression map when the persona's live2d model map isn't
# resolvable. EmotionExtractor strips ALL bracket tags regardless (so TTS text
# is always clean); this map only decides which known tags become the primary
# emotion passed to TTS. Covers the six primary axes from prompts/vtuber.md
# plus the standard nuance set.
_DEFAULT_EMOTION_MAP: Dict[str, int] = {
    "neutral": 0,
    "calm": 0,
    "joy": 1,
    "excitement": 1,
    "surprise": 1,
    "sadness": 2,
    "anger": 3,
    "fear": 4,
    "disgust": 5,
}

EmitFn = Callable[[str, dict], Awaitable[None]]


class RealtimeVoiceSession:
    """One realtime voice conversation, bound to a Geny agent session.

    Parameters
    ----------
    session_id:
        The Geny agent session this voice loop drives (same id used by
        ``execute_command`` / the chat room).
    emit:
        Async callback ``emit(event_type, data)`` the WS layer supplies;
        every server→client message goes through it.
    language:
        STT/TTS language hint. ``""`` = Whisper auto-detect.
    """

    def __init__(
        self,
        session_id: str,
        emit: EmitFn,
        *,
        language: str = "",
        voice_profile: Optional[str] = None,
        emotion_map: Optional[Dict[str, int]] = None,
    ) -> None:
        self.session_id = session_id
        self._emit = emit
        self._language = language
        self._voice_profile = voice_profile
        self._emotion_map = emotion_map or _DEFAULT_EMOTION_MAP

        # Monotonic turn generation. Every user utterance / barge-in bumps
        # it; in-flight producers compare against it and stop when stale.
        # This is the rewritten CancelScope: one integer instead of a
        # shared object, which is all Geny's single-writer loop needs.
        self._generation = 0
        self._turn_task: Optional[asyncio.Task] = None
        self._closed = False
        self._stream_raw = ""  # cumulative reply tokens for the active turn

        # STT-only: emit the transcript and let the frontend broadcast it to
        # the visible chat (default), vs run the persona turn here.
        self._stt_only = _cfg.stt_only_default()
        # ── server-side streaming VAD state (input_mode="server_vad") ──
        self._input_mode = _cfg.default_input_mode()
        self._vad = None                 # lazy SileroOnnx
        self._vad_failed = False         # VAD init failed → server_vad disabled
        self._turn_detector = None       # lazy StreamingTurnDetector
        self._pcm_tail = bytearray()     # bytes not yet aligned to a frame
        self._utt_frames: list[bytes] = []   # PCM frames of the current utterance
        self._recent_frames: list[bytes] = []  # ring for pre-speech padding
        self._utt_ms = 0.0               # length of the open utterance
        self._last_partial_ms = 0.0      # utt length at the last interim transcript
        self._partial_task: Optional[asyncio.Task] = None
        # Live-caption (interim transcript) state.
        self._partials_enabled = _cfg.partial_transcripts_enabled()  # per-conn default
        self._prev_partial = ""          # last interim text — for stable-prefix commit

    # ── lifecycle ────────────────────────────────────────────────────

    async def close(self) -> None:
        self._closed = True
        await self._cancel_active_turn()
        # Also cancel any in-flight partial-transcription task so it doesn't
        # keep holding a Whisper request for a session that's gone.
        pt = self._partial_task
        self._partial_task = None
        if pt and not pt.done():
            pt.cancel()
            try:
                await pt
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass

    def _is_stale(self, gen: int) -> bool:
        return gen != self._generation or self._closed

    async def _cancel_active_turn(self) -> None:
        """Stop the in-flight persona turn (barge-in / shutdown). Reuses
        the executor's own cancellation so all existing cleanup runs."""
        task = self._turn_task
        self._turn_task = None
        if task and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                # Propagate cancellation that targets THIS coroutine (e.g. the
                # WS teardown being cancelled) — only swallow the awaited task's.
                if task.cancelled():
                    pass
                else:
                    raise
            except Exception:  # noqa: BLE001
                pass
        # Also stop the underlying executor turn if it's still admitted.
        try:
            from service.execution.agent_executor import stop_execution
            await stop_execution(self.session_id)
        except Exception:  # noqa: BLE001
            logger.debug("[RealtimeVoice] stop_execution best-effort failed", exc_info=True)

    # ── inbound events (called by the WS layer) ──────────────────────

    async def on_speech_started(self) -> None:
        """User began speaking — barge in on any active reply. Bumping the
        generation makes every in-flight sentence/audio emit go stale; the
        frontend also stops local playback immediately on its own signal."""
        if self._turn_task and not self._turn_task.done():
            self._generation += 1
            gen = self._generation
            await self._cancel_active_turn()
            await self._safe_emit("cancelled", {"turn": gen})

    async def on_utterance(self, audio_bytes: bytes, *, fmt: str = "webm") -> None:
        """A complete user utterance (frontend VAD already segmented it).
        Transcribe, then run one persona turn."""
        # A new utterance supersedes any still-running turn.
        self._generation += 1
        gen = self._generation
        await self._cancel_active_turn()

        text = await self._transcribe(audio_bytes, fmt=fmt)
        if self._is_stale(gen):
            return
        if not text:
            await self._safe_emit("transcript", {"text": "", "final": True, "empty": True})
            return
        await self._safe_emit("transcript", {"text": text, "final": True})
        if not self._stt_only:
            await self.on_text(text, _gen=gen)

    async def on_text(self, text: str, *, _gen: Optional[int] = None) -> None:
        """Run one persona turn from ready text (typed input or post-STT)."""
        if _gen is None:
            self._generation += 1
            _gen = self._generation
            await self._cancel_active_turn()
        self._turn_task = asyncio.create_task(self._run_turn(text, _gen))

    # ── server-side streaming VAD input (input_mode="server_vad") ────

    def configure(
        self,
        *,
        input_mode: Optional[str] = None,
        stt_only: Optional[bool] = None,
        partials: Optional[bool] = None,
    ) -> None:
        """Per-connection reconfigure from the WS ``start`` message."""
        if input_mode in ("server_vad", "client_vad"):
            self._input_mode = input_mode
        if stt_only is not None:
            self._stt_only = bool(stt_only)
        if partials is not None:
            self._partials_enabled = bool(partials)

    def _ensure_vad(self) -> None:
        if self._vad is not None:
            return
        from .vad import SileroOnnx, StreamingTurnDetector
        self._vad = SileroOnnx()
        self._turn_detector = StreamingTurnDetector(
            threshold=_cfg.vad_threshold(),
            min_speech_ms=_cfg.vad_min_speech_ms(),
            min_silence_ms=_cfg.vad_min_silence_ms(),
            speech_pad_ms=_cfg.vad_speech_pad_ms(),
        )

    async def on_audio_frame(self, pcm: bytes) -> None:
        """Feed a chunk of raw 16 kHz int16 mono PCM (server_vad mode).

        Audio streams in continuously; the server VAD detects speech
        start (→ barge-in) and end (→ transcribe the accumulated
        utterance → run one persona turn). This is the "realtime input
        accumulates, end-of-speech goes straight to the executor" flow.
        """
        if self._closed or self._vad_failed:
            return
        from .vad import FRAME_BYTES, FRAME_SAMPLES, SAMPLE_RATE, pcm16_to_f32
        try:
            self._ensure_vad()
        except Exception:  # noqa: BLE001
            # onnxruntime missing / model unreadable — disable server VAD for
            # this connection once (don't die on every frame) and tell the
            # client so it can fall back to client_vad.
            self._vad_failed = True
            logger.warning("[RealtimeVoice] VAD init failed; server_vad disabled", exc_info=True)
            await self._safe_emit("error", {"error": "server_vad_unavailable"})
            return
        frame_ms = FRAME_SAMPLES / SAMPLE_RATE * 1000.0
        max_utt_ms = _cfg.vad_max_utterance_ms()
        # Retain enough recent frames to cover the whole speech build-up +
        # pre-pad, so the utterance onset isn't clipped when a turn opens.
        pad = self._turn_detector.lookback_frames

        # Bound the backlog: a single oversized/malicious binary frame (or a
        # burst) must never make the synchronous per-frame VAD loop below block
        # the event loop for seconds. Keep at most ~4 s of audio; drop the
        # oldest excess. Normal 128 ms chunks are far under this.
        self._pcm_tail.extend(pcm)
        max_tail = FRAME_BYTES * (SAMPLE_RATE * 4 // FRAME_SAMPLES)
        if len(self._pcm_tail) > max_tail:
            drop = len(self._pcm_tail) - max_tail
            del self._pcm_tail[:drop]
            logger.warning("[RealtimeVoice] dropped %d bytes of backlogged audio", drop)

        # Process frames via a moving offset (avoids O(n^2) bytes re-slicing),
        # yielding to the loop every ~1 s of audio so long batches don't stall.
        off = 0
        n = len(self._pcm_tail)
        processed = 0
        while n - off >= FRAME_BYTES:
            frame = bytes(self._pcm_tail[off:off + FRAME_BYTES])
            off += FRAME_BYTES
            processed += 1
            if processed % 32 == 0:
                await asyncio.sleep(0)  # let the event loop breathe

            try:
                prob = self._vad(pcm16_to_f32(frame))
            except Exception:  # noqa: BLE001
                logger.debug("[RealtimeVoice] VAD frame error", exc_info=True)
                continue
            ev = self._turn_detector.process(prob)

            # Maintain a short pre-speech ring so the leading sound survives.
            if not self._turn_detector.in_speech and ev is None:
                self._recent_frames.append(frame)
                if len(self._recent_frames) > pad:
                    self._recent_frames.pop(0)

            if ev is not None and ev.kind == "start":
                # Barge in on any active reply the instant speech starts.
                await self.on_speech_started()
                self._utt_frames = list(self._recent_frames)  # pre-pad
                self._recent_frames = []
                self._utt_ms = len(self._utt_frames) * frame_ms
                await self._safe_emit("speech_start", {})

            if self._turn_detector.in_speech:
                self._utt_frames.append(frame)
                self._utt_ms += frame_ms
                # Live "you're saying…" caption — transcribe the recent audio
                # window in the background (never blocks the loop). Bounded to
                # the last partial_window_ms so a long utterance can't blow up
                # the GPU cost.
                if (
                    self._partials_enabled
                    and self._utt_ms - self._last_partial_ms >= _cfg.partial_interval_ms()
                ):
                    self._last_partial_ms = self._utt_ms
                    win_frames = max(1, int(_cfg.partial_window_ms() / frame_ms))
                    self._spawn_partial(b"".join(self._utt_frames[-win_frames:]))
                # Force a turn if the user never pauses.
                if self._utt_ms >= max_utt_ms:
                    await self._finish_utterance()
                    continue

            if ev is not None and ev.kind == "end":
                await self._finish_utterance()

        # Drop all consumed frames in one O(n) splice, keeping the <1-frame tail.
        if off:
            del self._pcm_tail[:off]

    def _spawn_partial(self, pcm_snapshot: bytes) -> None:
        """Fire-and-forget interim transcription of the recent audio window.
        Only one runs at a time (skip if the previous is still going) so a slow
        GPU can't pile up requests.

        Emits a non-final ``transcript`` with ``stable_chars`` — the length of
        the prefix that also appeared in the PREVIOUS interim (LocalAgreement:
        text seen twice is settled). The client renders that prefix solid and
        the changing tail faded, so the caption grows smoothly instead of
        rewriting itself each pass."""
        if self._partial_task and not self._partial_task.done():
            return
        gen = self._generation
        prev = self._prev_partial

        async def _run() -> None:
            wav = _pcm16_to_wav(pcm_snapshot)
            text = await self._transcribe(wav, fmt="wav")
            # Drop if the utterance already ended / a new turn started.
            if not text or gen != self._generation:
                return
            if not (self._turn_detector and self._turn_detector.in_speech):
                return
            self._prev_partial = text
            await self._safe_emit(
                "transcript",
                {"text": text, "final": False, "stable_chars": _stable_prefix_chars(prev, text)},
            )

        self._partial_task = asyncio.create_task(_run())

    async def _finish_utterance(self) -> None:
        """Close the open utterance: assemble WAV → transcribe → run turn."""
        frames = self._utt_frames
        self._utt_frames = []
        self._utt_ms = 0.0
        self._last_partial_ms = 0.0
        self._prev_partial = ""
        # Reset the detector's in-speech latch if a forced (max-length) end.
        if self._turn_detector is not None and self._turn_detector.in_speech:
            self._turn_detector.reset_turn()
        if not frames:
            return
        await self._safe_emit("speech_end", {})
        pcm = b"".join(frames)
        wav = _pcm16_to_wav(pcm)

        self._generation += 1
        gen = self._generation
        await self._cancel_active_turn()
        text = await self._transcribe(wav, fmt="wav")
        if self._is_stale(gen):
            return
        if not text:
            await self._safe_emit("transcript", {"text": "", "final": True, "empty": True})
            return
        await self._safe_emit("transcript", {"text": text, "final": True})
        if not self._stt_only:
            await self.on_text(text, _gen=gen)

    # ── STT ──────────────────────────────────────────────────────────

    async def _transcribe(self, audio_bytes: bytes, *, fmt: str) -> str:
        try:
            from service.stt.whisper_client import get_whisper_client
            result = await get_whisper_client().atranscribe(
                audio_bytes,
                filename=f"utterance.{fmt}",
                language=self._language or None,
            )
        except Exception:  # noqa: BLE001
            logger.warning("[RealtimeVoice] transcription failed", exc_info=True)
            return ""
        if not result.is_ok():
            logger.info("[RealtimeVoice] STT unavailable/empty (source=%s)", result.source)
            return ""
        return (result.text or "").strip()

    # ── one persona turn: LLM bridge → sentences → TTS ───────────────

    async def _run_turn(self, prompt: str, gen: int) -> None:
        from service.execution.agent_executor import execute_command
        from service.logging.session_logger import get_session_logger
        from service.vtuber.emotion_extractor import EmotionExtractor
        from .sentence import IncrementalSentenceExtractor

        await self._safe_emit("turn_start", {"turn": gen})

        session_logger = get_session_logger(self.session_id, create_if_missing=False)
        cursor = session_logger.get_cache_length() if session_logger else 0

        extractor = IncrementalSentenceExtractor(
            min_chars=_cfg.sentence_min_chars(),
            max_chars=_cfg.sentence_max_chars(),
        )
        emotion_extractor = EmotionExtractor(self._emotion_map)
        seq = 0  # audio sequence within this turn
        self._stream_raw = ""  # cumulative reply tokens for THIS turn

        # Fire the persona turn. execute_command owns persona/memory/tools/
        # emotion — we only observe its STREAM output and speak it.
        exec_task = asyncio.create_task(
            execute_command(session_id=self.session_id, prompt=prompt, is_chat_message=True)
        )

        async def speak(sentence: str) -> None:
            nonlocal seq
            if self._is_stale(gen):
                return
            # Emotion tags must be read BEFORE any display sanitize (which
            # strips them). EmotionExtractor returns both the emotion and
            # the tag-free text; then sanitize_for_tts removes emoji /
            # markdown the audio engine would otherwise read literally.
            em = emotion_extractor.extract(sentence)
            subtitle = em.cleaned_text
            if not subtitle:
                return
            try:
                from service.utils.text_sanitizer import sanitize_for_tts
                tts_text = sanitize_for_tts(subtitle)
            except Exception:  # noqa: BLE001
                tts_text = subtitle
            await self._safe_emit(
                "assistant_text",
                {"text": subtitle, "emotion": em.primary_emotion, "turn": gen},
            )
            if not tts_text.strip():
                return
            try:
                from service.vtuber.tts.tts_service import get_tts_service
                async for chunk in get_tts_service().speak_sentences(
                    tts_text,
                    emotion=em.primary_emotion,
                    language=self._language or "ko",
                    voice_profile=self._voice_profile,
                ):
                    if self._is_stale(gen):
                        return
                    if chunk.is_final or not chunk.audio_data:
                        continue
                    await self._safe_emit(
                        "audio",
                        {
                            "turn": gen,
                            "seq": seq,
                            "audio_b64": base64.b64encode(chunk.audio_data).decode("ascii"),
                            "sample_rate": chunk.sample_rate,
                            "format": chunk.audio_format,
                        },
                    )
                    seq += 1
            except Exception:  # noqa: BLE001
                logger.warning("[RealtimeVoice] TTS failed for a sentence", exc_info=True)

        try:
            deadline = asyncio.get_running_loop().time() + _cfg.turn_hard_timeout_seconds()
            # Poll STREAM logs → extract sentences → speak, until the
            # persona turn completes (or we go stale / time out).
            while not exec_task.done():
                if self._is_stale(gen):
                    break
                await asyncio.sleep(max(0.005, _cfg.stream_poll_seconds()))
                if asyncio.get_running_loop().time() > deadline:
                    logger.warning("[RealtimeVoice] turn hard-timeout")
                    break
                if not session_logger:
                    continue
                new_entries, cursor = session_logger.get_cache_entries_since(cursor)
                if not new_entries:
                    continue
                cumulative = self._accumulate_stream(new_entries, extractor)
                if cumulative is None:
                    continue
                for sentence in extractor.push(cumulative):
                    await speak(sentence)

            # Drain the final tail from the completed turn.
            if not self._is_stale(gen):
                if session_logger:
                    new_entries, cursor = session_logger.get_cache_entries_since(cursor)
                    if new_entries:
                        cumulative = self._accumulate_stream(new_entries, extractor)
                        if cumulative is not None:
                            for sentence in extractor.push(cumulative):
                                await speak(sentence)
                for sentence in extractor.flush():
                    await speak(sentence)

            # Surface an execution error (best-effort; persona already logged).
            try:
                result = exec_task.result()
                if result is not None and not getattr(result, "success", True):
                    logger.info("[RealtimeVoice] persona turn returned success=False")
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001
                logger.debug("[RealtimeVoice] exec_task raised", exc_info=True)

        except asyncio.CancelledError:
            # Barge-in / shutdown. Make sure the executor turn is stopped.
            if not exec_task.done():
                exec_task.cancel()
            raise
        finally:
            if not exec_task.done():
                # Turn loop ended (stale/timeout) but persona still running —
                # let it finish in the background; do not cancel memory writes.
                logger.debug("[RealtimeVoice] leaving persona turn to complete in bg")
            if not self._is_stale(gen):
                await self._safe_emit("turn_end", {"turn": gen, "sentences": seq})

    # ── helpers ──────────────────────────────────────────────────────

    def _accumulate_stream(self, new_entries, extractor) -> Optional[str]:
        """Fold STREAM log entries into the cumulative reply text.

        Mirrors chat_controller._poll_logs: STREAM-level entries carry
        token text in ``entry.message``. Returns the cumulative string,
        or None if this batch had no STREAM tokens.
        """
        got = False
        for entry in new_entries:
            level = entry.level.value if hasattr(entry.level, "value") else str(entry.level)
            if level == "STREAM":
                self._stream_raw += (entry.message or "")
                got = True
        if not got:
            return None
        # Return the RAW cumulative text (emotion tags intact) — sanitizing
        # here would strip [joy] before speak() can read it. Cleaning happens
        # per-sentence in speak() (EmotionExtractor + sanitize_for_tts).
        return self._stream_raw

    async def _safe_emit(self, event_type: str, data: dict) -> None:
        try:
            await self._emit(event_type, data)
        except Exception:  # noqa: BLE001
            logger.debug("[RealtimeVoice] emit failed (%s)", event_type, exc_info=True)


def _stable_prefix_chars(prev: str, cur: str) -> int:
    """Char length of the leading run of WORDS that ``cur`` shares with
    ``prev`` — the interim text that has now been transcribed twice, so it is
    settled (LocalAgreement-2). Returns 0 when nothing matches yet.

    Word-granular (not char) so a half-typed word in ``cur`` isn't marked
    stable off a shorter ``prev``. The client renders ``cur[:n]`` solid and
    ``cur[n:]`` faded, so committed text stops flickering as later audio
    refines the tail.
    """
    if not prev or not cur:
        return 0
    pw, cw = prev.split(), cur.split()
    match = 0
    for a, b in zip(pw, cw):
        if a == b:
            match += 1
        else:
            break
    if match == 0:
        return 0
    return len(" ".join(cw[:match]))


def _pcm16_to_wav(pcm: bytes, *, sample_rate: int = 16000) -> bytes:
    """Wrap raw 16 kHz int16 mono PCM in a WAV container so Whisper's
    librosa decoder accepts it (it can't decode headerless PCM)."""
    import struct

    data_len = len(pcm)
    byte_rate = sample_rate * 2  # mono, 16-bit
    header = b"RIFF" + struct.pack("<I", 36 + data_len) + b"WAVE"
    header += b"fmt " + struct.pack("<IHHIIHH", 16, 1, 1, sample_rate, byte_rate, 2, 16)
    header += b"data" + struct.pack("<I", data_len)
    return header + pcm
