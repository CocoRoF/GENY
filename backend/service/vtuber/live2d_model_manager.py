"""
Live2D Model Manager

Loads model_registry.json, manages available Live2D models,
and tracks agent-model assignments.
"""

import json
from pathlib import Path
from dataclasses import dataclass, field
from typing import Dict, List, Optional
from logging import getLogger

logger = getLogger(__name__)


@dataclass
class Live2dModelInfo:
    """Metadata for a single avatar model.

    Despite the historical class name, an entry here can describe either
    a Live2D Cubism puppet or a Spine puppet — the `runtime` field tells
    consumers which renderer to use. Class rename is deferred to keep
    this PR small; the manager docstring covers the wider role.

    Schema versioning lives at the top level of model_registry.json
    (`schema_version`), bumped to 2 when `runtime` was introduced.
    Pre-v2 registries had no `runtime` field — we treat them as
    Live2D-only on load.
    """
    name: str
    display_name: str
    description: str
    url: str
    thumbnail: Optional[str]
    kScale: float
    initialXshift: float
    initialYshift: float
    idleMotionGroupName: str
    emotionMap: Dict[str, int]
    tapMotions: Dict[str, Dict[str, int]]
    emotionMotionMap: Dict[str, str] = field(default_factory=dict)
    hiddenParts: List[str] = field(default_factory=list)
    runtime: str = "live2d"
    # Spine-specific: the .atlas file URL (sibling of the .skel/.json).
    # Live2D entries leave this None.
    atlas_url: Optional[str] = None

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "display_name": self.display_name,
            "description": self.description,
            "url": self.url,
            "thumbnail": self.thumbnail,
            "kScale": self.kScale,
            "initialXshift": self.initialXshift,
            "initialYshift": self.initialYshift,
            "idleMotionGroupName": self.idleMotionGroupName,
            "emotionMap": self.emotionMap,
            "tapMotions": self.tapMotions,
            "emotionMotionMap": self.emotionMotionMap,
            "hiddenParts": self.hiddenParts,
            "runtime": self.runtime,
            "atlas_url": self.atlas_url,
        }


class Live2dModelManager:
    """
    Manages the avatar model registry and agent-model assignments.

    Originally Live2D-only (hence the class name); since the geny-avatar
    integration introduced `runtime` on each entry, this also manages
    Spine puppets in the same registry. Frontend dispatches the right
    renderer based on `entry.runtime`. Class rename is deferred — every
    consumer references `request.app.state.live2d_model_manager`, and a
    rename touches ~10 sites that aren't blockers for current work.

    Reads model_registry.json from the given directory, provides model
    lookup, and tracks which agent session uses which model.
    """

    def __init__(self, models_dir: str):
        self._models_dir = Path(models_dir)
        self._registry_path = self._models_dir / "model_registry.json"
        self._models: Dict[str, Live2dModelInfo] = {}
        self._default_model: str = ""
        self._agent_assignments: Dict[str, str] = {}  # session_id → model_name
        self._load_registry()

    def _load_registry(self):
        """Load model registry from JSON file."""
        if not self._registry_path.exists():
            logger.warning(f"Model registry not found: {self._registry_path}")
            return

        try:
            with open(self._registry_path, "r", encoding="utf-8") as f:
                data = json.load(f)

            schema_version = data.get("schema_version", 1)
            for model_data in data.get("models", []):
                info = Live2dModelInfo(
                    name=model_data["name"],
                    display_name=model_data.get("display_name", model_data["name"]),
                    description=model_data.get("description", ""),
                    url=model_data["url"],
                    thumbnail=model_data.get("thumbnail"),
                    kScale=model_data.get("kScale", 0.5),
                    initialXshift=model_data.get("initialXshift", 0),
                    initialYshift=model_data.get("initialYshift", 0),
                    idleMotionGroupName=model_data.get("idleMotionGroupName", "Idle"),
                    emotionMap=model_data.get("emotionMap", {"neutral": 0}),
                    tapMotions=model_data.get("tapMotions", {}),
                    emotionMotionMap=model_data.get("emotionMotionMap", {}),
                    hiddenParts=model_data.get("hiddenParts", []),
                    # Pre-v2 registries had no runtime field — fall back to
                    # live2d so old hand-crafted JSONs still load.
                    runtime=model_data.get("runtime", "live2d"),
                    atlas_url=model_data.get("atlas_url"),
                )
                self._models[info.name] = info

            self._default_model = data.get("default_model", "")
            self._agent_assignments = data.get("agent_model_assignments", {})

            logger.info(
                f"Loaded {len(self._models)} avatar models from registry "
                f"(schema_version={schema_version})"
            )
            for name, info in self._models.items():
                logger.info(f"  - {name} [{info.runtime}]: {info.display_name}")

        except Exception as e:
            logger.error(f"Failed to load model registry: {e}")

    @property
    def models(self) -> Dict[str, Live2dModelInfo]:
        return self._models

    @property
    def default_model_name(self) -> str:
        return self._default_model

    def list_models(self) -> List[Live2dModelInfo]:
        """Return list of all registered models."""
        return list(self._models.values())

    def get_model(self, name: str) -> Optional[Live2dModelInfo]:
        """Get model info by name."""
        return self._models.get(name)

    def get_default_model(self) -> Optional[Live2dModelInfo]:
        """Get the default model."""
        return self._models.get(self._default_model)

    def assign_model_to_agent(self, session_id: str, model_name: str):
        """Assign a Live2D model to an agent session."""
        if model_name not in self._models:
            raise ValueError(f"Unknown model: {model_name}. Available: {list(self._models.keys())}")
        self._agent_assignments[session_id] = model_name
        logger.info(f"Assigned model '{model_name}' to session '{session_id}'")

    def get_agent_model(self, session_id: str) -> Optional[Live2dModelInfo]:
        """Get the model assigned to an agent session."""
        model_name = self._agent_assignments.get(session_id)
        if not model_name:
            return None
        return self._models.get(model_name)

    def get_agent_model_name(self, session_id: str) -> Optional[str]:
        """Get the model name assigned to an agent session."""
        return self._agent_assignments.get(session_id)

    def unassign_model(self, session_id: str):
        """Remove model assignment for a session."""
        self._agent_assignments.pop(session_id, None)

    def get_all_assignments(self) -> Dict[str, str]:
        """Return all agent-model assignments."""
        return dict(self._agent_assignments)
