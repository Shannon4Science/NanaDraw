import json
import logging
import os
import threading
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

DEFAULTS: dict[str, Any] = {
    "llm_api_key": "",
    "image_api_key": "",
    "vision_api_key": "",
    "llm_base_url": "",
    "image_base_url": "",
    "vision_base_url": "",
    "llm_model": "gemini-3.1-pro-preview",
    "llm_image_model": "gemini-3-pro-image-preview",
    "llm_component_model": "gemini-3.1-flash-image-preview",
    "api_format": "auto",
    "nana_soul": "",
    "language": "zh",
}

ALLOWED_KEYS = set(DEFAULTS.keys())

_lock = threading.Lock()


def _settings_path() -> Path:
    from app.services.local_storage import get_data_dir

    return get_data_dir() / "settings.json"


def mask_api_key(api_key: str | None) -> str:
    s = "" if api_key is None else str(api_key).strip()
    if not s:
        return ""
    if len(s) <= 4:
        return "****"
    return f"****{s[-4:]}"


def _read_json_file(path: Path) -> dict[str, Any] | None:
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else None
    except FileNotFoundError:
        return None
    except (json.JSONDecodeError, OSError) as e:
        logger.warning("Failed to read settings %s: %s", path, e)
        return None


def _merge_with_defaults(raw: dict[str, Any]) -> dict[str, Any]:
    out = dict(DEFAULTS)
    for k in ALLOWED_KEYS:
        if k in raw:
            out[k] = raw[k]
    return out


def _atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    try:
        tmp.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        os.replace(tmp, path)
    except OSError:
        if tmp.is_file():
            try:
                tmp.unlink()
            except OSError:
                pass
        raise


def _load_unlocked() -> dict[str, Any]:
    path = _settings_path()
    if not path.is_file():
        merged = dict(DEFAULTS)
        _atomic_write_json(path, merged)
        return merged
    raw = _read_json_file(path)
    if raw is None:
        merged = dict(DEFAULTS)
        _atomic_write_json(path, merged)
        return merged
    return _merge_with_defaults(raw)


def _persist_unlocked(merged: dict[str, Any]) -> dict[str, Any]:
    path = _settings_path()
    to_store = {k: merged[k] for k in ALLOWED_KEYS}
    _atomic_write_json(path, to_store)
    log_payload = {
        **to_store,
        "llm_api_key": mask_api_key(str(to_store.get("llm_api_key", ""))),
        "image_api_key": mask_api_key(str(to_store.get("image_api_key", ""))),
        "vision_api_key": mask_api_key(str(to_store.get("vision_api_key", ""))),
    }
    logger.info("Settings saved: %s", log_payload)
    return dict(to_store)


def load_settings() -> dict[str, Any]:
    """Load settings from disk, merge with defaults for missing keys."""
    with _lock:
        return _load_unlocked().copy()


def save_settings(data: dict[str, Any]) -> dict[str, Any]:
    """Validate and save settings. Returns the saved settings dict.
    Only ALLOWED_KEYS are persisted. llm_api_key is masked in logs."""
    with _lock:
        merged = _load_unlocked()
        for k in ALLOWED_KEYS:
            if k in data:
                merged[k] = data[k]
        return _persist_unlocked(merged)


def get_setting(key: str) -> Any:
    """Get a single setting value."""
    if key not in ALLOWED_KEYS:
        raise KeyError(key)
    with _lock:
        return _load_unlocked()[key]


def update_settings(updates: dict[str, Any]) -> dict[str, Any]:
    """Partial update: merge updates into existing settings."""
    with _lock:
        merged = _load_unlocked()
        for k, v in updates.items():
            if k in ALLOWED_KEYS:
                merged[k] = v
        return _persist_unlocked(merged)


def is_configured() -> bool:
    """Check if at minimum llm_api_key is set."""
    with _lock:
        return bool(str(_load_unlocked().get("llm_api_key", "")).strip())
