"""Minimal static configuration. LLM values are fallbacks; runtime overrides come from settings_service."""

import os
from pathlib import Path
from types import SimpleNamespace

PROJECT_NAME = "NanaDraw"
VERSION = "0.19.0"
API_V1_PREFIX = "/api/v1"

CORS_ORIGINS: list[str] = [
    "http://localhost:3000",
    "http://localhost:3001",
    "https://embed.diagrams.net",
]

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"
DATA_DIR = Path(os.environ.get("NANADRAW_DATA_DIR", "~/.nanadraw")).expanduser()

# Fallback LLM settings (overridden by settings_service at runtime)
LLM_API_KEY = os.environ.get("LLM_API_KEY", "")
LLM_BASE_URL = os.environ.get("LLM_BASE_URL", "")
LLM_MODEL = os.environ.get("LLM_MODEL", "gemini-3.1-pro-preview")
LLM_IMAGE_MODEL = os.environ.get("LLM_IMAGE_MODEL", "gemini-3-pro-image-preview")
LLM_IMAGE_MODEL_BACKUP = os.environ.get("LLM_IMAGE_MODEL_BACKUP", "")
LLM_IMAGE_MODEL_FLASH = os.environ.get("LLM_IMAGE_MODEL_FLASH", "gemini-3.1-flash-image-preview")
LLM_COMPONENT_MODEL = os.environ.get("LLM_COMPONENT_MODEL", "")
FAL_API_KEY = os.environ.get("FAL_API_KEY", "")

LLM_MAX_RETRIES = int(os.environ.get("LLM_MAX_RETRIES", "3"))
LLM_GLOBAL_IMAGE_CONCURRENCY = int(os.environ.get("LLM_GLOBAL_IMAGE_CONCURRENCY", "8"))

GALLERY_CDN_BASE = os.environ.get("GALLERY_CDN_BASE", "")

ENABLE_AI_ASSISTANT = os.environ.get("ENABLE_AI_ASSISTANT", "true").lower() in (
    "1",
    "true",
    "yes",
)

# Logical key prefix for project/image storage paths (not cloud credentials)
S3_PREFIX = os.environ.get("NANADRAW_STORAGE_PREFIX", "nanadraw")

settings = SimpleNamespace(
    PROJECT_NAME=PROJECT_NAME,
    VERSION=VERSION,
    API_V1_PREFIX=API_V1_PREFIX,
    CORS_ORIGINS=CORS_ORIGINS,
    STATIC_DIR=STATIC_DIR,
    DATA_DIR=DATA_DIR,
    LLM_API_KEY=LLM_API_KEY,
    LLM_BASE_URL=LLM_BASE_URL,
    LLM_MODEL=LLM_MODEL,
    LLM_IMAGE_MODEL=LLM_IMAGE_MODEL,
    LLM_IMAGE_MODEL_BACKUP=LLM_IMAGE_MODEL_BACKUP,
    LLM_IMAGE_MODEL_FLASH=LLM_IMAGE_MODEL_FLASH,
    LLM_COMPONENT_MODEL=LLM_COMPONENT_MODEL,
    FAL_API_KEY=FAL_API_KEY,
    LLM_MAX_RETRIES=LLM_MAX_RETRIES,
    LLM_GLOBAL_IMAGE_CONCURRENCY=LLM_GLOBAL_IMAGE_CONCURRENCY,
    GALLERY_CDN_BASE=GALLERY_CDN_BASE,
    ENABLE_AI_ASSISTANT=ENABLE_AI_ASSISTANT,
    S3_PREFIX=S3_PREFIX,
    s3_configured=False,
)
