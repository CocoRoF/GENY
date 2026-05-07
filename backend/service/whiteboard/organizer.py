"""
Organizer — auto-suggest moves on the user's whiteboard.

The Organizer never *applies* anything itself. It produces
``OrganizationSuggestion`` objects (cluster, near-duplicate, promote
to library, stale-unseen) that are surfaced in the
``<SuggestionsBar>`` slot in the Inbox UI; the user accepts or
rejects each one.

Strategy registration mirrors the rest of the whiteboard surface:
``ORGANIZER_REGISTRY[strategy_name] = StrategyImpl()``. New
strategies plug in by adding a single line.

This phase ships four strategies:

  * EmbeddingClusterStrategy  — embedding-based topical clusters.
  * NearDuplicateStrategy      — pairs of notes that look almost
                                 identical (very high similarity).
  * TopicPromotionStrategy     — high-view notes that look ready
                                 for the curated Library.
  * StaleUnseenStrategy        — old notes the agent has never
                                 actually consumed.

The first three need an embedding callable; if none is available,
they degrade to lightweight token-overlap signals so they're still
useful in environments without a configured embedding client.

A ticker invokes ``run_organizer_for_user`` periodically (low rate;
default 24h). The same entry point is also called on demand from
``POST /api/opsidian/organizer/run`` so the user can hit "Organize
now" from the UI.

Suggestion state is durable: stored in
``{vault}/_organizer_suggestions.jsonl`` (one line per suggestion)
so accept / reject persists across restarts and the same suggestion
isn't re-proposed within its cooldown.
"""

from __future__ import annotations

import json
import math
import os
import re
import threading
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, timezone
from logging import getLogger
from pathlib import Path
from typing import (
    Any,
    Callable,
    Dict,
    Iterable,
    List,
    Mapping,
    Optional,
    Protocol,
    Sequence,
    Tuple,
)

from .view_ledger import ViewLedgerSnapshot, get_view_ledger

logger = getLogger(__name__)


# ── Datatypes ────────────────────────────────────────────────────────


SuggestionStatus = str  # "active" | "accepted" | "rejected" | "snoozed"


@dataclass
class OrganizationSuggestion:
    """A single recommendation surfaced to the user.

    Strategies populate every required field; the controller adds
    ``status`` / ``created_at`` / ``decided_at`` / ``cooldown_until``.
    """

    suggestion_id: str
    kind: str  # "cluster" | "duplicate" | "topic_promotion" | "stale_unseen"
    note_filenames: List[str]
    proposed_label: str
    proposed_action: str  # "group" | "merge" | "promote_to_library" | "archive" | "tag"
    confidence: float
    rationale: str
    strategy_name: str
    status: SuggestionStatus = "active"
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    decided_at: Optional[str] = None
    cooldown_until: Optional[str] = None
    extra: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "OrganizationSuggestion":
        return cls(
            suggestion_id=str(data["suggestion_id"]),
            kind=str(data.get("kind") or "cluster"),
            note_filenames=list(data.get("note_filenames") or []),
            proposed_label=str(data.get("proposed_label") or ""),
            proposed_action=str(data.get("proposed_action") or "group"),
            confidence=float(data.get("confidence") or 0.0),
            rationale=str(data.get("rationale") or ""),
            strategy_name=str(data.get("strategy_name") or "unknown"),
            status=str(data.get("status") or "active"),
            created_at=str(
                data.get("created_at") or datetime.now(timezone.utc).isoformat()
            ),
            decided_at=data.get("decided_at"),
            cooldown_until=data.get("cooldown_until"),
            extra=dict(data.get("extra") or {}),
        )


# ── Strategy Protocol ────────────────────────────────────────────────


class OrganizerStrategy(Protocol):
    name: str

    def propose(
        self,
        notes: Sequence[Mapping[str, Any]],
        embeddings: Mapping[str, Sequence[float]],
        view_snapshot: ViewLedgerSnapshot,
    ) -> List[OrganizationSuggestion]: ...


# ── Helpers used by multiple strategies ──────────────────────────────


_TOKEN_RE = re.compile(r"\w{3,}", re.UNICODE)


def _tokenize(text: str) -> List[str]:
    return [t.lower() for t in _TOKEN_RE.findall(text or "")]


def _bag_overlap(a: Sequence[str], b: Sequence[str]) -> float:
    """Jaccard-like overlap on token bags. 1.0 = identical."""
    if not a or not b:
        return 0.0
    sa, sb = set(a), set(b)
    inter = len(sa & sb)
    union = len(sa | sb)
    if union == 0:
        return 0.0
    return inter / union


def _cosine(a: Sequence[float], b: Sequence[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


# ── Strategies ───────────────────────────────────────────────────────


@dataclass
class EmbeddingClusterStrategy:
    """Group notes whose embeddings (or token bags) are similar.

    Algorithm: greedy, threshold-based — for every note, add to the
    first cluster whose centroid is above the similarity threshold;
    otherwise start a new cluster. Cheap and deterministic; good
    enough for whiteboards in the dozens-to-hundreds-of-notes range.
    Larger volumes can swap this for HDBSCAN / k-means without
    touching the surrounding pipeline.
    """

    name: str = "embedding_cluster"
    similarity_threshold: float = 0.55
    min_cluster_size: int = 3
    max_clusters: int = 8

    def propose(
        self,
        notes: Sequence[Mapping[str, Any]],
        embeddings: Mapping[str, Sequence[float]],
        view_snapshot: ViewLedgerSnapshot,
    ) -> List[OrganizationSuggestion]:
        if len(notes) < self.min_cluster_size:
            return []

        token_bags: Dict[str, List[str]] = {}
        for n in notes:
            fn = str(n.get("filename") or "")
            if not fn:
                continue
            text = f"{n.get('title') or ''} {n.get('body') or n.get('snippet') or ''}"
            token_bags[fn] = _tokenize(text)

        clusters: List[List[str]] = []
        cluster_centroids_emb: List[List[float]] = []
        cluster_centroids_tok: List[List[str]] = []

        for n in notes:
            fn = str(n.get("filename") or "")
            if not fn:
                continue
            placed = False
            for idx, members in enumerate(clusters):
                sim = self._similarity(
                    fn,
                    members[0],
                    embeddings,
                    token_bags,
                    cluster_centroids_emb[idx],
                    cluster_centroids_tok[idx],
                )
                if sim >= self.similarity_threshold:
                    members.append(fn)
                    self._update_centroid(
                        idx,
                        fn,
                        embeddings,
                        token_bags,
                        cluster_centroids_emb,
                        cluster_centroids_tok,
                    )
                    placed = True
                    break
            if not placed:
                clusters.append([fn])
                emb = list(embeddings.get(fn, []))
                cluster_centroids_emb.append(emb)
                cluster_centroids_tok.append(list(token_bags.get(fn, [])))

        suggestions: List[OrganizationSuggestion] = []
        for members in clusters:
            if len(members) < self.min_cluster_size:
                continue
            label = self._cluster_label(members, token_bags)
            view_total = sum(
                self._view_total(view_snapshot, fn) for fn in members
            )
            suggestions.append(
                OrganizationSuggestion(
                    suggestion_id=uuid.uuid4().hex,
                    kind="cluster",
                    note_filenames=list(members),
                    proposed_label=label,
                    proposed_action="group",
                    confidence=min(0.95, 0.4 + 0.05 * len(members)),
                    rationale=(
                        f"{len(members)} notes share recurring keywords "
                        f"({label!r}); total view activity {view_total}."
                    ),
                    strategy_name=self.name,
                    extra={"view_total": view_total},
                )
            )
            if len(suggestions) >= self.max_clusters:
                break

        # Surface bigger / more-active clusters first.
        suggestions.sort(
            key=lambda s: (
                -len(s.note_filenames),
                -float(s.extra.get("view_total", 0) or 0),
            )
        )
        return suggestions

    @staticmethod
    def _similarity(
        a_fn: str,
        b_fn: str,
        embeddings: Mapping[str, Sequence[float]],
        token_bags: Mapping[str, Sequence[str]],
        centroid_emb: Sequence[float],
        centroid_tok: Sequence[str],
    ) -> float:
        emb_a = embeddings.get(a_fn)
        if emb_a and centroid_emb:
            return _cosine(emb_a, centroid_emb)
        return _bag_overlap(token_bags.get(a_fn, []), centroid_tok)

    @staticmethod
    def _update_centroid(
        idx: int,
        fn: str,
        embeddings: Mapping[str, Sequence[float]],
        token_bags: Mapping[str, Sequence[str]],
        centroids_emb: List[List[float]],
        centroids_tok: List[List[str]],
    ) -> None:
        emb = embeddings.get(fn)
        if emb and centroids_emb[idx]:
            centroids_emb[idx] = [
                (a + b) / 2 for a, b in zip(centroids_emb[idx], emb)
            ]
        else:
            # Token-bag mode: just extend (stays cheap because we only
            # use it for set-overlap).
            centroids_tok[idx] = list(set(centroids_tok[idx]) | set(token_bags.get(fn, [])))

    @staticmethod
    def _cluster_label(
        members: Sequence[str], token_bags: Mapping[str, Sequence[str]]
    ) -> str:
        counts: Dict[str, int] = {}
        for fn in members:
            for tok in token_bags.get(fn, []):
                counts[tok] = counts.get(tok, 0) + 1
        # Top 3 distinctive tokens — short, descriptive, deterministic.
        ranked = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
        head = [t for t, c in ranked[:3] if c >= max(2, len(members) // 2)]
        if not head:
            head = [t for t, _ in ranked[:2]]
        return ", ".join(head[:3]) or "Unlabeled cluster"

    @staticmethod
    def _view_total(snapshot: ViewLedgerSnapshot, filename: str) -> int:
        from .view_ledger import ViewKey

        for key, record in snapshot.items():
            if key.note_id == filename:
                return record.total()
        return 0


@dataclass
class NearDuplicateStrategy:
    name: str = "near_duplicate"
    similarity_threshold: float = 0.92

    def propose(
        self,
        notes: Sequence[Mapping[str, Any]],
        embeddings: Mapping[str, Sequence[float]],
        view_snapshot: ViewLedgerSnapshot,
    ) -> List[OrganizationSuggestion]:
        token_bags: Dict[str, List[str]] = {}
        for n in notes:
            fn = str(n.get("filename") or "")
            text = f"{n.get('title') or ''} {n.get('body') or n.get('snippet') or ''}"
            token_bags[fn] = _tokenize(text)

        items = [str(n.get("filename")) for n in notes if n.get("filename")]
        suggestions: List[OrganizationSuggestion] = []
        seen_pairs: set[tuple[str, str]] = set()
        for i, fn_a in enumerate(items):
            for fn_b in items[i + 1 :]:
                pair = tuple(sorted((fn_a, fn_b)))
                if pair in seen_pairs:
                    continue
                seen_pairs.add(pair)
                emb_a = embeddings.get(fn_a)
                emb_b = embeddings.get(fn_b)
                if emb_a and emb_b:
                    sim = _cosine(emb_a, emb_b)
                else:
                    sim = _bag_overlap(token_bags.get(fn_a, []), token_bags.get(fn_b, []))
                if sim < self.similarity_threshold:
                    continue
                suggestions.append(
                    OrganizationSuggestion(
                        suggestion_id=uuid.uuid4().hex,
                        kind="duplicate",
                        note_filenames=list(pair),
                        proposed_label=f"~{int(sim * 100)}% similar",
                        proposed_action="merge",
                        confidence=float(sim),
                        rationale=(
                            f"Two notes share ~{int(sim * 100)}% of content; "
                            f"merging avoids duplicate state."
                        ),
                        strategy_name=self.name,
                        extra={"similarity": sim},
                    )
                )
        suggestions.sort(key=lambda s: -s.confidence)
        return suggestions


@dataclass
class TopicPromotionStrategy:
    name: str = "topic_promotion"
    min_age_days: int = 3
    min_view_activity: int = 4

    def propose(
        self,
        notes: Sequence[Mapping[str, Any]],
        embeddings: Mapping[str, Sequence[float]],
        view_snapshot: ViewLedgerSnapshot,
    ) -> List[OrganizationSuggestion]:
        suggestions: List[OrganizationSuggestion] = []
        cutoff = datetime.now(timezone.utc) - timedelta(days=self.min_age_days)
        for n in notes:
            fn = str(n.get("filename") or "")
            if not fn:
                continue
            if str(n.get("category") or "") != "inbox":
                # Only promote *from* the inbox.
                continue
            created_at = self._parse_dt(n.get("created"))
            if created_at and created_at > cutoff:
                continue
            view_total = sum(
                rec.total()
                for k, rec in view_snapshot.items()
                if k.note_id == fn
            )
            if view_total < self.min_view_activity:
                continue
            suggestions.append(
                OrganizationSuggestion(
                    suggestion_id=uuid.uuid4().hex,
                    kind="topic_promotion",
                    note_filenames=[fn],
                    proposed_label=str(n.get("title") or fn),
                    proposed_action="promote_to_library",
                    confidence=min(0.95, 0.5 + 0.05 * view_total),
                    rationale=(
                        f"VTuber has read / referenced this {view_total} time(s) "
                        f"since it landed in the inbox — looks ready for the Library."
                    ),
                    strategy_name=self.name,
                    extra={"view_total": view_total},
                )
            )
        suggestions.sort(key=lambda s: -s.confidence)
        return suggestions

    @staticmethod
    def _parse_dt(value: Any) -> Optional[datetime]:
        if isinstance(value, str) and value:
            try:
                dt = datetime.fromisoformat(value)
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                return dt
            except ValueError:
                return None
        return None


@dataclass
class StaleUnseenStrategy:
    name: str = "stale_unseen"
    min_age_days: int = 14

    def propose(
        self,
        notes: Sequence[Mapping[str, Any]],
        embeddings: Mapping[str, Sequence[float]],
        view_snapshot: ViewLedgerSnapshot,
    ) -> List[OrganizationSuggestion]:
        cutoff = datetime.now(timezone.utc) - timedelta(days=self.min_age_days)
        seen_filenames = {k.note_id for k, _ in view_snapshot.items()}
        suggestions: List[OrganizationSuggestion] = []
        for n in notes:
            fn = str(n.get("filename") or "")
            if not fn or fn in seen_filenames:
                continue
            created_at = self._parse_dt(n.get("created"))
            if created_at is None or created_at > cutoff:
                continue
            suggestions.append(
                OrganizationSuggestion(
                    suggestion_id=uuid.uuid4().hex,
                    kind="stale_unseen",
                    note_filenames=[fn],
                    proposed_label=str(n.get("title") or fn),
                    proposed_action="archive",
                    confidence=0.7,
                    rationale=(
                        f"Note has been here for {self.min_age_days}+ days "
                        f"and the agent has never read it. Safe to archive "
                        f"or delete unless you're saving it for later."
                    ),
                    strategy_name=self.name,
                )
            )
        return suggestions

    @staticmethod
    def _parse_dt(value: Any) -> Optional[datetime]:
        return TopicPromotionStrategy._parse_dt(value)


# ── Registry ─────────────────────────────────────────────────────────


ORGANIZER_REGISTRY: Dict[str, OrganizerStrategy] = {
    "embedding_cluster": EmbeddingClusterStrategy(),
    "near_duplicate": NearDuplicateStrategy(),
    "topic_promotion": TopicPromotionStrategy(),
    "stale_unseen": StaleUnseenStrategy(),
}


# ── Suggestion store (per-user, on-disk) ─────────────────────────────


_SUGGESTION_LOG = "_organizer_suggestions.jsonl"

_store_lock = threading.Lock()


def _suggestions_path(vault_root: str) -> Path:
    return Path(vault_root) / _SUGGESTION_LOG


def load_suggestions(vault_root: str) -> List[OrganizationSuggestion]:
    """Read every persisted suggestion. Newest last; caller filters."""
    path = _suggestions_path(vault_root)
    if not path.exists():
        return []
    out: List[OrganizationSuggestion] = []
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except (ValueError, json.JSONDecodeError):
                continue
            try:
                out.append(OrganizationSuggestion.from_dict(row))
            except Exception:  # noqa: BLE001
                continue
    except OSError:
        pass
    return out


def _write_all(vault_root: str, items: Iterable[OrganizationSuggestion]) -> None:
    path = _suggestions_path(vault_root)
    with _store_lock:
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("w", encoding="utf-8") as handle:
                for s in items:
                    handle.write(json.dumps(s.to_dict(), ensure_ascii=False) + "\n")
        except OSError:
            logger.warning("organizer: failed to write suggestion log", exc_info=True)


def list_active_suggestions(vault_root: str) -> List[OrganizationSuggestion]:
    """Active = status == "active" AND cooldown not in force.

    Suggestions older than 30 days are dropped silently regardless of
    status, so the log doesn't grow unbounded.
    """
    cutoff = datetime.now(timezone.utc) - timedelta(days=30)
    out: List[OrganizationSuggestion] = []
    now = datetime.now(timezone.utc)
    for s in load_suggestions(vault_root):
        try:
            created = datetime.fromisoformat(s.created_at)
            if created.tzinfo is None:
                created = created.replace(tzinfo=timezone.utc)
        except ValueError:
            created = now
        if created < cutoff:
            continue
        if s.status != "active":
            continue
        if s.cooldown_until:
            try:
                cd = datetime.fromisoformat(s.cooldown_until)
                if cd.tzinfo is None:
                    cd = cd.replace(tzinfo=timezone.utc)
                if cd > now:
                    continue
            except ValueError:
                pass
        out.append(s)
    out.sort(key=lambda s: (-s.confidence, s.created_at))
    return out


def add_suggestions(
    vault_root: str, fresh: Iterable[OrganizationSuggestion]
) -> int:
    """Append ``fresh`` suggestions, deduping against active ones.

    Dedup key: ``(strategy_name, sorted note_filenames)`` — replaying
    the same proposal doesn't pile up multiple cards.
    """
    existing = load_suggestions(vault_root)
    active_keys = {
        (s.strategy_name, tuple(sorted(s.note_filenames)))
        for s in existing
        if s.status == "active"
    }
    rejected_keys = {
        (s.strategy_name, tuple(sorted(s.note_filenames)))
        for s in existing
        if s.status == "rejected"
    }
    added = 0
    next_log = list(existing)
    for s in fresh:
        key = (s.strategy_name, tuple(sorted(s.note_filenames)))
        if key in active_keys or key in rejected_keys:
            continue
        next_log.append(s)
        added += 1
    if added:
        _write_all(vault_root, next_log)
    return added


def update_status(
    vault_root: str,
    suggestion_id: str,
    *,
    status: SuggestionStatus,
    cooldown_days: Optional[int] = None,
) -> Optional[OrganizationSuggestion]:
    items = load_suggestions(vault_root)
    found: Optional[OrganizationSuggestion] = None
    now = datetime.now(timezone.utc)
    for s in items:
        if s.suggestion_id == suggestion_id:
            s.status = status
            s.decided_at = now.isoformat()
            if cooldown_days:
                s.cooldown_until = (now + timedelta(days=cooldown_days)).isoformat()
            found = s
            break
    if found is not None:
        _write_all(vault_root, items)
    return found


# ── Runner ───────────────────────────────────────────────────────────


def run_organizer_for_user(
    username: str,
    *,
    agent_id: Optional[str] = None,
    strategy_names: Optional[Sequence[str]] = None,
    embedding_fn: Optional[Callable[[str], Sequence[float]]] = None,
) -> List[OrganizationSuggestion]:
    """Run the requested strategies and persist the new suggestions.

    Returns the list of *newly added* suggestions (after dedup).

    ``embedding_fn`` is optional: when supplied, strategies use real
    embeddings; when missing, they degrade to token-bag overlap.
    Geny doesn't always carry an embedding client — keeping this
    optional means the Organizer is useful in any deployment.
    """
    try:
        from service.memory.user_opsidian import get_user_opsidian_manager
    except Exception:  # noqa: BLE001
        return []
    mgr = get_user_opsidian_manager(username)
    notes = mgr.list_notes() or []
    # Hydrate body (the manager listing only returns metadata) for
    # the strategies that look at content. Cap at 200 notes to keep
    # the runner bounded.
    hydrated: List[Dict[str, Any]] = []
    for meta in notes[:200]:
        fn = meta.get("filename")
        if not fn:
            continue
        full = mgr.read_note(fn) or {}
        hydrated.append(
            {
                **meta,
                "body": full.get("body") or "",
            }
        )

    embeddings: Dict[str, List[float]] = {}
    if embedding_fn is not None:
        for n in hydrated:
            fn = str(n.get("filename") or "")
            try:
                vec = embedding_fn(
                    f"{n.get('title') or ''}\n{n.get('body') or ''}"
                )
                if vec:
                    embeddings[fn] = list(vec)
            except Exception:  # noqa: BLE001
                continue

    snapshot = (
        get_view_ledger(username, agent_id).snapshot()
        if username
        else ViewLedgerSnapshot({})
    )

    chosen = strategy_names or list(ORGANIZER_REGISTRY.keys())
    fresh: List[OrganizationSuggestion] = []
    for sname in chosen:
        strat = ORGANIZER_REGISTRY.get(sname)
        if strat is None:
            continue
        try:
            fresh.extend(strat.propose(hydrated, embeddings, snapshot))
        except Exception:  # noqa: BLE001
            logger.warning("organizer strategy %s failed", sname, exc_info=True)
            continue

    added = add_suggestions(mgr.vault_root, fresh)
    if added:
        logger.info(
            "organizer: %d new suggestion(s) for %s across %d strategies",
            added,
            username,
            len(chosen),
        )
    # Return the active list (post-dedup) so callers can render
    # immediately without a follow-up GET.
    return list_active_suggestions(mgr.vault_root)
