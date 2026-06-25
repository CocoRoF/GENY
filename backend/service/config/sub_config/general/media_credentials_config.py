"""Image-generation provider keys (fal.ai, Replicate).

These aren't used by Geny's own LLM pipeline — they belong to geny-avatar's
image-gen stack (FLUX via fal, SAM via Replicate). Geny holds them centrally so
they can be **synced to the avatar** (`apply_change=synced_env`, which pushes to
the avatar's config.json). Visible in Settings → General; the OpenAI/Gemini image
keys are the same as Geny's LLM keys and live in LLMCredentialsConfig.
"""

from dataclasses import dataclass
from typing import List

from service.config.base import BaseConfig, ConfigField, FieldType, register_config
from service.config.sub_config.general.env_utils import read_env_defaults
from service.sync.provider_key_sync import synced_env


@register_config
@dataclass
class MediaCredentialsConfig(BaseConfig):
    """Optional image-generation provider keys (synced to geny-avatar)."""

    fal_key: str = ""
    replicate_api_token: str = ""

    _ENV_MAP = {
        "fal_key": "FAL_KEY",
        "replicate_api_token": "REPLICATE_API_TOKEN",
    }

    @classmethod
    def get_default_instance(cls) -> "MediaCredentialsConfig":
        defaults = read_env_defaults(cls._ENV_MAP, cls.__dataclass_fields__)
        return cls(**defaults)

    @classmethod
    def get_config_name(cls) -> str:
        return "media_credentials"

    @classmethod
    def get_display_name(cls) -> str:
        return "Image Generation Keys"

    @classmethod
    def get_description(cls) -> str:
        return "fal.ai / Replicate keys for geny-avatar's image pipeline. Synced to the avatar."

    @classmethod
    def get_category(cls) -> str:
        return "general"

    @classmethod
    def get_icon(cls) -> str:
        return "image"

    @classmethod
    def get_fields_metadata(cls) -> List[ConfigField]:
        return [
            ConfigField(
                name="fal_key",
                field_type=FieldType.PASSWORD,
                label="fal.ai Key",
                description="fal.ai API key (FLUX image models in geny-avatar).",
                placeholder="fal-…",
                group="image_generation",
                secure=True,
                apply_change=synced_env("FAL_KEY"),
            ),
            ConfigField(
                name="replicate_api_token",
                field_type=FieldType.PASSWORD,
                label="Replicate API Token",
                description="Replicate token (SAM segmentation in geny-avatar).",
                placeholder="r8_…",
                group="image_generation",
                secure=True,
                apply_change=synced_env("REPLICATE_API_TOKEN"),
            ),
        ]
