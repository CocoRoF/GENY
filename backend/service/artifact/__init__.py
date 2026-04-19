"""Artifact catalog service — port of web ``app/services/artifact_service``."""

from service.artifact.service import ArtifactError, ArtifactService

__all__ = ["ArtifactError", "ArtifactService"]
