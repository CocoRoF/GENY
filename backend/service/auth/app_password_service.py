"""
App password issue/verify/revoke for protocol clients (WebDAV Basic auth).

Verification runs on EVERY DAV request, so it must be cheap and safe:
- sha256(secret) lookup + constant-time compare (secrets are ~130-bit
  CSPRNG output — see model docstring for why not bcrypt),
- a small in-process TTL cache so a mount doing a PROPFIND storm costs
  one DB lookup per minute, not per request,
- negative results are NOT cached (a just-created password must work
  immediately; a wrong guess re-checks — the 130-bit space makes online
  guessing irrelevant anyway).

Revocation must actually cut a live mount off, so the cache is keyed by
the secret hash and dropped on revoke.
"""
import hashlib
import hmac
import logging
import secrets
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from service.database.models.app_password import AppPasswordModel

logger = logging.getLogger(__name__)

# xxxxx-xxxxx-xxxxx-xxxxx-xxxxxx over a 32-char alphabet ≈ 130 bits.
_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"  # no 0/O/1/l/i lookalikes
_GROUPS = (5, 5, 5, 5, 6)

_CACHE_TTL_S = 60.0
_LAST_USED_WRITE_INTERVAL_S = 300.0  # last_used_at is coarse on purpose


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _hash(secret: str) -> str:
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()


def generate_secret() -> str:
    return "-".join(
        "".join(secrets.choice(_ALPHABET) for _ in range(n)) for n in _GROUPS
    )


class AppPasswordService:
    def __init__(self, app_db) -> None:
        self._db = app_db
        # secret_hash -> (username, verified_monotonic, last_used_flushed)
        self._cache: Dict[str, tuple] = {}

    # ── management (called from authenticated REST endpoints) ────────

    def create(self, username: str, label: str) -> Dict[str, Any]:
        """Mint a new secret. The plaintext appears in the response ONCE
        and is never reconstructable afterwards."""
        secret = generate_secret()
        rec = AppPasswordModel(
            username=username,
            label=(label or "device")[:200],
            secret_hash=_hash(secret),
            prefix=secret[:5],
            created_at=_now_iso(),
        )
        inserted = self._db.insert(rec)
        rec_id = (inserted or {}).get("id")
        return {
            "id": rec_id,
            "label": rec.label,
            "prefix": rec.prefix,
            "created_at": rec.created_at,
            "secret": secret,
        }

    def list_for(self, username: str) -> List[Dict[str, Any]]:
        rows = self._db.find_by_condition(AppPasswordModel, {"username": username}) or []
        out = []
        for r in rows:
            d = r.to_dict() if hasattr(r, "to_dict") else dict(r)
            out.append(
                {
                    "id": d.get("id"),
                    "label": d.get("label"),
                    "prefix": d.get("prefix"),
                    "created_at": d.get("created_at"),
                    "last_used_at": d.get("last_used_at") or None,
                }
            )
        return out

    def revoke(self, username: str, rec_id: int) -> bool:
        rows = self._db.find_by_condition(AppPasswordModel, {"username": username}) or []
        for r in rows:
            d = r.to_dict() if hasattr(r, "to_dict") else dict(r)
            if d.get("id") == rec_id:
                ok = self._db.delete(AppPasswordModel, rec_id)
                if ok:
                    # cut live mounts off now, not at cache expiry
                    self._cache.pop(str(d.get("secret_hash") or ""), None)
                return bool(ok)
        return False

    # ── verification (hot path — every DAV request) ──────────────────

    def verify(self, username: str, secret: str) -> bool:
        if not username or not secret:
            return False
        h = _hash(secret)
        now = time.monotonic()

        hit = self._cache.get(h)
        if hit and hit[0] == username and (now - hit[1]) < _CACHE_TTL_S:
            return True

        try:
            rows = self._db.find_by_condition(
                AppPasswordModel, {"username": username}
            ) or []
        except Exception as e:  # noqa: BLE001
            logger.error(f"app-password lookup failed: {e}")
            return False

        for r in rows:
            d = r.to_dict() if hasattr(r, "to_dict") else dict(r)
            stored = str(d.get("secret_hash") or "")
            # compare_digest over the hex digests — length is constant, so
            # this leaks nothing even across multiple stored rows.
            if stored and hmac.compare_digest(stored, h):
                flushed = hit[2] if hit else 0.0
                if (now - flushed) > _LAST_USED_WRITE_INTERVAL_S:
                    self._touch_last_used(d)
                    flushed = now
                self._cache[h] = (username, now, flushed)
                return True
        return False

    def _touch_last_used(self, d: Dict[str, Any]) -> None:
        try:
            rec = AppPasswordModel(**{k: v for k, v in d.items() if k != "id"})
            rec.id = d.get("id")
            rec.last_used_at = _now_iso()
            self._db.update(rec)
        except Exception:  # noqa: BLE001
            pass  # cosmetic metadata — never fail auth over it


_service: Optional[AppPasswordService] = None


def init_app_password_service(app_db) -> AppPasswordService:
    global _service
    _service = AppPasswordService(app_db)
    return _service


def get_app_password_service() -> Optional[AppPasswordService]:
    return _service
