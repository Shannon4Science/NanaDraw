import asyncio
import hashlib
import json
import logging
import os
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_ENV_DATA_DIR = "NANADRAW_DATA_DIR"


def get_data_dir() -> Path:
    raw = os.environ.get(_ENV_DATA_DIR, "").strip()
    base = Path(raw).expanduser() if raw else Path.home() / ".nanadraw"
    base.mkdir(parents=True, exist_ok=True)
    return base.resolve()


def _ensure_dir(p: Path) -> Path:
    p.mkdir(parents=True, exist_ok=True)
    return p


def _new_id() -> str:
    return uuid.uuid4().hex[:12]


def _utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return None
    except (json.JSONDecodeError, OSError) as e:
        logger.warning("Failed to read JSON %s: %s", path, e)
        return None


def _write_json(path: Path, data: dict[str, Any]) -> None:
    import tempfile
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _projects_root() -> Path:
    return _ensure_dir(get_data_dir() / "projects")


def _assets_root() -> Path:
    return _ensure_dir(get_data_dir() / "assets")


def _safe_segment(name: str) -> bool:
    return bool(name) and name == Path(name).name and ".." not in name and "/" not in name and "\\" not in name


def _list_projects_sync() -> list[dict[str, Any]]:
    base = _projects_root()
    out: list[dict[str, Any]] = []
    if not base.is_dir():
        return out
    for d in base.iterdir():
        if not d.is_dir():
            continue
        meta = _read_json(d / "meta.json")
        if meta is not None:
            out.append(meta)
    out.sort(key=lambda x: str(x.get("updated_at", "")), reverse=True)
    return out


def _get_project_sync(project_id: str) -> dict[str, Any] | None:
    if not _safe_segment(project_id):
        logger.warning("Invalid project_id: %s", project_id)
        return None
    meta_path = _projects_root() / project_id / "meta.json"
    return _read_json(meta_path)


def _create_project_sync(name: str, canvas_type: str) -> dict[str, Any]:
    projects_dir = _projects_root()
    project_id = _new_id()
    while (projects_dir / project_id).exists():
        project_id = _new_id()
    proj_dir = projects_dir / project_id
    _ensure_dir(proj_dir / "images")
    now = _utc_iso()
    meta: dict[str, Any] = {
        "id": project_id,
        "name": name,
        "canvas_type": canvas_type,
        "created_at": now,
        "updated_at": now,
    }
    _write_json(proj_dir / "meta.json", meta)
    return meta


def _update_project_sync(project_id: str, **kwargs: Any) -> dict[str, Any] | None:
    if not _safe_segment(project_id):
        logger.warning("Invalid project_id: %s", project_id)
        return None
    meta_path = _projects_root() / project_id / "meta.json"
    meta = _read_json(meta_path)
    if meta is None:
        return None
    allowed = {"name", "canvas_type"}
    for k, v in kwargs.items():
        if k in allowed and v is not None:
            meta[k] = v
    meta["updated_at"] = _utc_iso()
    _write_json(meta_path, meta)
    return meta


def _delete_project_sync(project_id: str) -> bool:
    if not _safe_segment(project_id):
        logger.warning("Invalid project_id: %s", project_id)
        return False
    target = _projects_root() / project_id
    if not target.is_dir():
        return False
    try:
        shutil.rmtree(target)
        return True
    except OSError as e:
        logger.error("Failed to delete project %s: %s", project_id, e)
        return False


def _save_canvas_sync(project_id: str, xml: str) -> bool:
    if not _safe_segment(project_id):
        logger.warning("Invalid project_id: %s", project_id)
        return False
    proj_dir = _projects_root() / project_id
    if not proj_dir.is_dir():
        return False
    path = proj_dir / "canvas.xml"
    try:
        path.write_text(xml, encoding="utf-8")
        meta_path = proj_dir / "meta.json"
        meta = _read_json(meta_path)
        if meta is not None:
            meta["updated_at"] = _utc_iso()
            _write_json(meta_path, meta)
        return True
    except OSError as e:
        logger.error("Failed to save canvas for %s: %s", project_id, e)
        return False


def _load_canvas_sync(project_id: str) -> str | None:
    if not _safe_segment(project_id):
        logger.warning("Invalid project_id: %s", project_id)
        return None
    path = _projects_root() / project_id / "canvas.xml"
    try:
        return path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    except OSError as e:
        logger.warning("Failed to load canvas for %s: %s", project_id, e)
        return None


def _save_thumbnail_sync(project_id: str, image_data: bytes) -> bool:
    if not _safe_segment(project_id):
        logger.warning("Invalid project_id: %s", project_id)
        return False
    proj_dir = _projects_root() / project_id
    if not proj_dir.is_dir():
        return False
    path = proj_dir / "thumbnail.png"
    try:
        path.write_bytes(image_data)
        meta_path = proj_dir / "meta.json"
        meta = _read_json(meta_path)
        if meta is not None:
            meta["updated_at"] = _utc_iso()
            _write_json(meta_path, meta)
        return True
    except OSError as e:
        logger.error("Failed to save thumbnail for %s: %s", project_id, e)
        return False


def _load_thumbnail_sync(project_id: str) -> bytes | None:
    if not _safe_segment(project_id):
        logger.warning("Invalid project_id: %s", project_id)
        return None
    path = _projects_root() / project_id / "thumbnail.png"
    try:
        return path.read_bytes()
    except FileNotFoundError:
        return None
    except OSError as e:
        logger.warning("Failed to load thumbnail for %s: %s", project_id, e)
        return None


def _normalize_image_hash(image_hash: str) -> str:
    h = image_hash.strip()
    if h.lower().endswith(".png"):
        h = h[: -len(".png")]
    return h.lower()


def _save_image_sync(project_id: str, image_data: bytes) -> str:
    if not _safe_segment(project_id):
        raise ValueError("invalid project_id")
    proj_dir = _projects_root() / project_id
    if not proj_dir.is_dir():
        raise ValueError("project not found")
    digest = hashlib.sha256(image_data).hexdigest()
    images_dir = _ensure_dir(proj_dir / "images")
    path = images_dir / f"{digest}.png"
    try:
        path.write_bytes(image_data)
        meta_path = proj_dir / "meta.json"
        meta = _read_json(meta_path)
        if meta is not None:
            meta["updated_at"] = _utc_iso()
            _write_json(meta_path, meta)
    except OSError as e:
        logger.error("Failed to save image for %s: %s", project_id, e)
        raise
    return digest


def _load_image_sync(project_id: str, image_hash: str) -> bytes | None:
    if not _safe_segment(project_id):
        logger.warning("Invalid project_id: %s", project_id)
        return None
    h = _normalize_image_hash(image_hash)
    if not h or not all(c in "0123456789abcdef" for c in h):
        logger.warning("Invalid image hash: %s", image_hash)
        return None
    path = _projects_root() / project_id / "images" / f"{h}.png"
    try:
        return path.read_bytes()
    except FileNotFoundError:
        return None
    except OSError as e:
        logger.warning("Failed to load image %s for %s: %s", h, project_id, e)
        return None


def _content_filename_for_type(content_type: str) -> str:
    ct = content_type.lower()
    if "svg" in ct:
        return "content.svg"
    return "content.png"


def _list_assets_sync() -> list[dict[str, Any]]:
    base = _assets_root()
    out: list[dict[str, Any]] = []
    if not base.is_dir():
        return out
    for d in base.iterdir():
        if not d.is_dir():
            continue
        meta = _read_json(d / "meta.json")
        if meta is not None:
            out.append(meta)
    out.sort(key=lambda x: str(x.get("created_at", "")), reverse=True)
    return out


def _get_asset_sync(asset_id: str) -> dict[str, Any] | None:
    if not _safe_segment(asset_id):
        logger.warning("Invalid asset_id: %s", asset_id)
        return None
    return _read_json(_assets_root() / asset_id / "meta.json")


def _create_asset_sync(
    display_name: str, category: str, content: bytes, content_type: str
) -> dict[str, Any]:
    assets_dir = _assets_root()
    asset_id = _new_id()
    while (assets_dir / asset_id).exists():
        asset_id = _new_id()
    asset_dir = _ensure_dir(assets_dir / asset_id)
    fname = _content_filename_for_type(content_type)
    now = _utc_iso()
    meta: dict[str, Any] = {
        "id": asset_id,
        "display_name": display_name,
        "category": category,
        "content_type": content_type,
        "created_at": now,
    }
    _write_json(asset_dir / "meta.json", meta)
    (asset_dir / fname).write_bytes(content)
    return meta


def _delete_asset_sync(asset_id: str) -> bool:
    if not _safe_segment(asset_id):
        logger.warning("Invalid asset_id: %s", asset_id)
        return False
    target = _assets_root() / asset_id
    if not target.is_dir():
        return False
    try:
        shutil.rmtree(target)
        return True
    except OSError as e:
        logger.error("Failed to delete asset %s: %s", asset_id, e)
        return False


def _load_asset_content_sync(asset_id: str) -> tuple[bytes, str] | None:
    if not _safe_segment(asset_id):
        logger.warning("Invalid asset_id: %s", asset_id)
        return None
    asset_dir = _assets_root() / asset_id
    meta = _read_json(asset_dir / "meta.json")
    if meta is None:
        return None
    content_type = str(meta.get("content_type", "application/octet-stream"))
    for name in ("content.svg", "content.png"):
        p = asset_dir / name
        if p.is_file():
            try:
                return p.read_bytes(), content_type
            except OSError as e:
                logger.warning("Failed to read asset content %s: %s", p, e)
                return None
    return None


async def list_projects() -> list[dict[str, Any]]:
    return await asyncio.to_thread(_list_projects_sync)


async def get_project(project_id: str) -> dict[str, Any] | None:
    return await asyncio.to_thread(_get_project_sync, project_id)


async def create_project(name: str, canvas_type: str = "drawio") -> dict[str, Any]:
    return await asyncio.to_thread(_create_project_sync, name, canvas_type)


async def update_project(project_id: str, **kwargs: Any) -> dict[str, Any] | None:
    return await asyncio.to_thread(_update_project_sync, project_id, **kwargs)


async def delete_project(project_id: str) -> bool:
    return await asyncio.to_thread(_delete_project_sync, project_id)


async def save_canvas(project_id: str, xml: str) -> bool:
    return await asyncio.to_thread(_save_canvas_sync, project_id, xml)


async def load_canvas(project_id: str) -> str | None:
    return await asyncio.to_thread(_load_canvas_sync, project_id)


async def save_thumbnail(project_id: str, image_data: bytes) -> bool:
    return await asyncio.to_thread(_save_thumbnail_sync, project_id, image_data)


async def load_thumbnail(project_id: str) -> bytes | None:
    return await asyncio.to_thread(_load_thumbnail_sync, project_id)


async def save_image(project_id: str, image_data: bytes) -> str:
    return await asyncio.to_thread(_save_image_sync, project_id, image_data)


async def load_image(project_id: str, image_hash: str) -> bytes | None:
    return await asyncio.to_thread(_load_image_sync, project_id, image_hash)


async def list_assets() -> list[dict[str, Any]]:
    return await asyncio.to_thread(_list_assets_sync)


async def get_asset(asset_id: str) -> dict[str, Any] | None:
    return await asyncio.to_thread(_get_asset_sync, asset_id)


async def create_asset(
    display_name: str, category: str, content: bytes, content_type: str
) -> dict[str, Any]:
    return await asyncio.to_thread(
        _create_asset_sync, display_name, category, content, content_type
    )


async def delete_asset(asset_id: str) -> bool:
    return await asyncio.to_thread(_delete_asset_sync, asset_id)


async def load_asset_content(asset_id: str) -> tuple[bytes, str] | None:
    return await asyncio.to_thread(_load_asset_content_sync, asset_id)
