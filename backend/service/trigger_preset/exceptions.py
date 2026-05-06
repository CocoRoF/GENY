"""Exceptions for the Trigger Preset layer."""

from __future__ import annotations


class TriggerPresetNotFoundError(LookupError):
    """Raised when a preset id does not exist in the store."""


class TriggerPresetValidationError(ValueError):
    """Raised when a payload fails schema-level validation."""
