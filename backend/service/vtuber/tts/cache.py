"""
TTS 오디오 캐시 시스템

인메모리 인덱스 + 파일 기반 캐시.
text + emotion + engine + voice → SHA256 해시 → 캐시 파일.
TTL 기반 만료, LRU 삭제.
"""

import hashlib
import json
import logging
import os
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

CACHE_DIR = Path(__file__).parent.parent.parent.parent / "cache" / "tts"
INDEX_FILE = CACHE_DIR / "_index.json"


@dataclass
class CacheEntry:
    """캐시 항목 메타데이터."""

    key: str
    file: str
    created: float
    size: int
    text_preview: str
    emotion: str
    engine: str
    last_accessed: float = field(default_factory=time.time)


def _make_cache_key(text: str, emotion: str, engine: str, voice_id: str) -> str:
    """텍스트+감정+엔진+보이스 → 고유 해시."""
    raw = f"{text}|{emotion}|{engine}|{voice_id}"
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


class TTSCache:
    """TTS 오디오 파일 캐시."""

    def __init__(self) -> None:
        self._index: dict[str, CacheEntry] = {}
        self._loaded = False

    def _ensure_dir(self) -> None:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)

    def _load_index(self) -> None:
        if self._loaded:
            return
        self._ensure_dir()
        if INDEX_FILE.exists():
            try:
                data = json.loads(INDEX_FILE.read_text(encoding="utf-8"))
                for key, entry_data in data.items():
                    self._index[key] = CacheEntry(**entry_data)
            except Exception as e:
                logger.warning(f"Failed to load cache index: {e}")
                self._index = {}
        self._loaded = True

    def _save_index(self) -> None:
        self._ensure_dir()
        try:
            data = {k: asdict(v) for k, v in self._index.items()}
            INDEX_FILE.write_text(
                json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
            )
        except Exception as e:
            logger.warning(f"Failed to save cache index: {e}")

    def _is_enabled(self) -> bool:
        """Config에서 캐시 활성화 여부 확인."""
        try:
            from service.config.manager import get_config_manager
            from service.config.sub_config.tts.tts_general_config import (
                TTSGeneralConfig,
            )

            config = get_config_manager().load_config(TTSGeneralConfig)
            return config.cache_enabled
        except Exception:
            return False

    def _get_limits(self) -> tuple[int, int]:
        """Config에서 최대 크기(MB)와 TTL(시간) 반환."""
        try:
            from service.config.manager import get_config_manager
            from service.config.sub_config.tts.tts_general_config import (
                TTSGeneralConfig,
            )

            config = get_config_manager().load_config(TTSGeneralConfig)
            return config.cache_max_size, config.cache_ttl
        except Exception:
            return 500, 24

    def get(
        self, text: str, emotion: str, engine: str, voice_id: str
    ) -> Optional[bytes]:
        """캐시된 오디오 데이터 반환. 없으면 None."""
        if not self._is_enabled():
            return None

        self._load_index()
        key = _make_cache_key(text, emotion, engine, voice_id)
        entry = self._index.get(key)
        if not entry:
            return None

        # TTL 체크
        _, ttl_hours = self._get_limits()
        if time.time() - entry.created > ttl_hours * 3600:
            self._remove_entry(key)
            return None

        # 파일 존재 확인
        file_path = CACHE_DIR / entry.file
        if not file_path.exists():
            del self._index[key]
            return None

        # LRU 갱신
        entry.last_accessed = time.time()
        logger.debug(f"Cache hit: {key} ({entry.text_preview})")
        return file_path.read_bytes()

    def put(
        self,
        text: str,
        emotion: str,
        engine: str,
        voice_id: str,
        audio_data: bytes,
        audio_format: str = "mp3",
    ) -> None:
        """오디오 데이터를 캐시에 저장."""
        if not self._is_enabled():
            return

        self._load_index()
        key = _make_cache_key(text, emotion, engine, voice_id)

        # 용량 확인 & LRU 정리
        self._evict_if_needed(len(audio_data))

        # 파일 저장
        self._ensure_dir()
        filename = f"{key}.{audio_format}"
        file_path = CACHE_DIR / filename
        file_path.write_bytes(audio_data)

        # 인덱스 갱신
        self._index[key] = CacheEntry(
            key=key,
            file=filename,
            created=time.time(),
            size=len(audio_data),
            text_preview=text[:50],
            emotion=emotion,
            engine=engine,
            last_accessed=time.time(),
        )
        self._save_index()
        logger.debug(f"Cached: {key} ({len(audio_data)} bytes)")

    def _remove_entry(self, key: str) -> None:
        """캐시 항목 삭제."""
        entry = self._index.pop(key, None)
        if entry:
            file_path = CACHE_DIR / entry.file
            try:
                file_path.unlink(missing_ok=True)
            except Exception:
                pass

    def _evict_if_needed(self, incoming_size: int) -> None:
        """최대 크기 초과 시 LRU로 삭제."""
        max_mb, _ = self._get_limits()
        max_bytes = max_mb * 1024 * 1024

        total_size = sum(e.size for e in self._index.values()) + incoming_size
        if total_size <= max_bytes:
            return

        # LRU 정렬 (오래된 것부터)
        sorted_entries = sorted(self._index.values(), key=lambda e: e.last_accessed)
        for entry in sorted_entries:
            if total_size <= max_bytes:
                break
            total_size -= entry.size
            self._remove_entry(entry.key)
            logger.debug(f"Evicted cache: {entry.key}")

        self._save_index()

    def clear(self) -> None:
        """전체 캐시 삭제."""
        self._load_index()
        for key in list(self._index.keys()):
            self._remove_entry(key)
        self._index.clear()
        self._save_index()
        logger.info("TTS cache cleared")

    def stats(self) -> dict:
        """캐시 통계."""
        self._load_index()
        total_size = sum(e.size for e in self._index.values())
        max_mb, ttl_hours = self._get_limits()
        return {
            "enabled": self._is_enabled(),
            "entries": len(self._index),
            "total_size_mb": round(total_size / 1024 / 1024, 2),
            "max_size_mb": max_mb,
            "ttl_hours": ttl_hours,
        }


# 싱글턴
_cache: Optional[TTSCache] = None


def get_tts_cache() -> TTSCache:
    global _cache
    if _cache is None:
        _cache = TTSCache()
    return _cache
