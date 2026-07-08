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

# How often to drain the STREAM log cache while the persona is generating.
# Matches the chat controller's token-streaming granularity (50 ms).
_STREAM_POLL_S = 0.05
# Cap a single turn so a stuck persona can't pin the loop forever; the
# executor has its own timeout, this is a backstop.
_TURN_HARD_TIMEOUT_S = 180.0

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

    # ── lifecycle ────────────────────────────────────────────────────

    async def close(self) -> None:
        self._closed = True
        await self._cancel_active_turn()

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
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
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
        await self.on_text(text, _gen=gen)

    async def on_text(self, text: str, *, _gen: Optional[int] = None) -> None:
        """Run one persona turn from ready text (typed input or post-STT)."""
        if _gen is None:
            self._generation += 1
            _gen = self._generation
            await self._cancel_active_turn()
        self._turn_task = asyncio.create_task(self._run_turn(text, _gen))

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

        extractor = IncrementalSentenceExtractor()
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
            deadline = asyncio.get_event_loop().time() + _TURN_HARD_TIMEOUT_S
            # Poll STREAM logs → extract sentences → speak, until the
            # persona turn completes (or we go stale / time out).
            while not exec_task.done():
                if self._is_stale(gen):
                    break
                await asyncio.sleep(_STREAM_POLL_S)
                if asyncio.get_event_loop().time() > deadline:
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
