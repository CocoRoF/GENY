"""Pydantic schemas for ``/api/catalog``.

Byte-compatible port of ``geny_executor_web.app.schemas.catalog``. Mirrors
the executor introspection dataclasses' ``to_dict`` output so the backend
stays a thin pass-through.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class ArtifactInfoResponse(BaseModel):
    stage: str
    name: str
    description: str = ""
    version: str = "1.0"
    stability: str = "stable"
    requires: List[str] = Field(default_factory=list)
    is_default: bool = False
    provides_stage: bool = True
    extra: Dict[str, Any] = Field(default_factory=dict)


class SlotIntrospectionResponse(BaseModel):
    slot_name: str
    description: str = ""
    required: bool = False
    current_impl: str = ""
    available_impls: List[str] = Field(default_factory=list)
    impl_schemas: Dict[str, Optional[Dict[str, Any]]] = Field(default_factory=dict)
    impl_descriptions: Dict[str, str] = Field(default_factory=dict)


class ChainIntrospectionResponse(BaseModel):
    chain_name: str
    description: str = ""
    current_impls: List[str] = Field(default_factory=list)
    available_impls: List[str] = Field(default_factory=list)
    impl_schemas: Dict[str, Optional[Dict[str, Any]]] = Field(default_factory=dict)
    impl_descriptions: Dict[str, str] = Field(default_factory=dict)


class StageIntrospectionResponse(BaseModel):
    stage: str
    artifact: str
    order: int
    name: str
    category: str = ""
    artifact_info: ArtifactInfoResponse
    config_schema: Optional[Dict[str, Any]] = None
    config: Dict[str, Any] = Field(default_factory=dict)
    strategy_slots: Dict[str, SlotIntrospectionResponse] = Field(default_factory=dict)
    strategy_chains: Dict[str, ChainIntrospectionResponse] = Field(default_factory=dict)
    tool_binding_supported: bool = True
    model_override_supported: bool = True
    required: bool = False
    extra: Dict[str, Any] = Field(default_factory=dict)


class StageSummaryResponse(BaseModel):
    order: int
    module: str
    name: str
    category: str = ""
    default_artifact: str = "default"
    artifact_count: int = 0


class StageListResponse(BaseModel):
    stages: List[StageSummaryResponse]


class ArtifactListResponse(BaseModel):
    stage: str
    artifacts: List[ArtifactInfoResponse]


class FullCatalogResponse(BaseModel):
    stages: List[StageIntrospectionResponse]


__all__ = [
    "ArtifactInfoResponse",
    "SlotIntrospectionResponse",
    "ChainIntrospectionResponse",
    "StageIntrospectionResponse",
    "StageSummaryResponse",
    "StageListResponse",
    "ArtifactListResponse",
    "FullCatalogResponse",
]
