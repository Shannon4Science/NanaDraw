"""Project CRUD endpoints (local filesystem storage)."""

import asyncio
import base64
import binascii
import gzip
import hashlib
import re
import zlib

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response

from app.dependencies import LocalUser, get_current_user
from app.schemas.project import (
    CanvasSaveRequest,
    ImageBatchGetRequest,
    ImageUploadRequest,
    ProjectCreate,
    ProjectDetail,
    ProjectInfo,
    ProjectListResponse,
    ProjectUpdate,
)
from app.services import local_storage

router = APIRouter(prefix="/projects", tags=["projects"])

_SHA256_HEX = re.compile(r"^[a-fA-F0-9]{64}$")


def _assert_image_hash(image_hash: str) -> None:
    if not _SHA256_HEX.match(image_hash):
        raise HTTPException(400, "无效的图片哈希")


async def _project_info(row: dict) -> ProjectInfo:
    thumb_url = None
    tid = row["id"]
    thumb = await local_storage.load_thumbnail(tid)
    if thumb is not None:
        thumb_url = f"/api/v1/projects/{tid}/thumbnail"
    return ProjectInfo(
        id=tid,
        name=row["name"],
        canvas_type=row["canvas_type"],
        status="active",
        thumbnail_url=thumb_url,
        created_at=str(row["created_at"]) if row.get("created_at") else None,
        updated_at=str(row["updated_at"]) if row.get("updated_at") else None,
    )


@router.post("")
async def create_project(body: ProjectCreate, _user: LocalUser = Depends(get_current_user)):
    proj = await local_storage.create_project(name=body.name, canvas_type=body.canvas_type)
    return {"id": proj["id"], "name": proj["name"], "canvas_type": proj["canvas_type"]}


@router.get("")
async def list_projects(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    _user: LocalUser = Depends(get_current_user),
):
    all_rows = await local_storage.list_projects()
    total = len(all_rows)
    start = (page - 1) * page_size
    slice_rows = all_rows[start : start + page_size]
    items = await asyncio.gather(*(_project_info(p) for p in slice_rows))
    return ProjectListResponse(projects=list(items), total=total, page=page, page_size=page_size)


@router.get("/{project_id}")
async def get_project(project_id: str, _user: LocalUser = Depends(get_current_user)):
    proj = await local_storage.get_project(project_id)
    if not proj:
        raise HTTPException(404, "项目不存在")

    info = await _project_info(proj)
    canvas = await local_storage.load_canvas(project_id)
    drawio_url = f"/api/v1/projects/{project_id}/canvas" if canvas else None

    return ProjectDetail(**info.model_dump(), drawio_url=drawio_url)


@router.put("/{project_id}")
async def update_project(
    project_id: str, body: ProjectUpdate, _user: LocalUser = Depends(get_current_user),
):
    proj = await local_storage.get_project(project_id)
    if not proj:
        raise HTTPException(404, "项目不存在")

    updates = body.model_dump(exclude_none=True)
    if updates:
        updated = await local_storage.update_project(project_id, **updates)
        if not updated:
            raise HTTPException(404, "项目不存在")
    return {"ok": True}


@router.get("/{project_id}/canvas")
async def get_canvas(project_id: str, _user: LocalUser = Depends(get_current_user)):
    proj = await local_storage.get_project(project_id)
    if not proj:
        raise HTTPException(404, "项目不存在")

    data = await local_storage.load_canvas(project_id)
    if data is None:
        raise HTTPException(404, "画布数据不存在")

    canvas_type = proj["canvas_type"]
    content_type = "application/xml" if canvas_type == "drawio" else "application/json"
    return Response(content=data.encode("utf-8"), media_type=content_type)


@router.get("/{project_id}/thumbnail")
async def get_thumbnail(project_id: str, _user: LocalUser = Depends(get_current_user)):
    proj = await local_storage.get_project(project_id)
    if not proj:
        raise HTTPException(404, "项目不存在")

    data = await local_storage.load_thumbnail(project_id)
    if data is None:
        raise HTTPException(404, "缩略图不存在")

    return Response(
        content=data,
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=300"},
    )


@router.put("/{project_id}/thumbnail")
async def put_thumbnail(
    project_id: str, body: ImageUploadRequest, _user: LocalUser = Depends(get_current_user),
):
    proj = await local_storage.get_project(project_id)
    if not proj:
        raise HTTPException(404, "项目不存在")
    try:
        png_bytes = base64.b64decode(body.data, validate=True)
    except binascii.Error as e:
        raise HTTPException(400, "无效的 Base64 图片数据") from e
    ok = await local_storage.save_thumbnail(project_id, png_bytes)
    if not ok:
        raise HTTPException(500, "缩略图保存失败")
    return {"ok": True}


@router.put("/{project_id}/canvas")
async def save_canvas(project_id: str, body: CanvasSaveRequest, _user: LocalUser = Depends(get_current_user)):
    proj = await local_storage.get_project(project_id)
    if not proj:
        raise HTTPException(404, "项目不存在")

    try:
        if body.canvas_encoding == "gzip_b64":
            canvas_bytes = gzip.decompress(base64.b64decode(body.canvas_data))
        elif body.canvas_encoding == "deflate_b64":
            canvas_bytes = zlib.decompress(base64.b64decode(body.canvas_data))
        else:
            canvas_bytes = body.canvas_data.encode("utf-8")
    except (binascii.Error, OSError, zlib.error, ValueError) as e:
        raise HTTPException(400, f"无效的画布压缩数据: {e}") from e

    try:
        canvas_text = canvas_bytes.decode("utf-8")
    except UnicodeDecodeError as e:
        raise HTTPException(400, "画布数据不是有效的 UTF-8") from e

    ok = await local_storage.save_canvas(project_id, canvas_text)
    if not ok:
        raise HTTPException(500, "画布保存失败")

    if body.thumbnail_b64:
        thumb_data = base64.b64decode(body.thumbnail_b64)
        await local_storage.save_thumbnail(project_id, thumb_data)

    return {"ok": True}


@router.post("/{project_id}/images/batch")
async def batch_get_project_images(
    project_id: str,
    body: ImageBatchGetRequest,
    _user: LocalUser = Depends(get_current_user),
):
    proj = await local_storage.get_project(project_id)
    if not proj:
        raise HTTPException(404, "项目不存在")

    for h in body.hashes:
        if not _SHA256_HEX.match(h):
            raise HTTPException(400, "无效的图片哈希")

    async def fetch_one(image_hash: str) -> tuple[str, str | None]:
        data = await local_storage.load_image(project_id, image_hash)
        if data is None:
            return (image_hash, None)
        return (image_hash, base64.b64encode(data).decode("ascii"))

    pairs = await asyncio.gather(*(fetch_one(h) for h in body.hashes))
    images = {h: b64 for h, b64 in pairs if b64 is not None}
    return {"images": images}


@router.post("/{project_id}/images")
async def post_project_image(
    project_id: str,
    body: ImageUploadRequest,
    _user: LocalUser = Depends(get_current_user),
):
    proj = await local_storage.get_project(project_id)
    if not proj:
        raise HTTPException(404, "项目不存在")
    try:
        png_bytes = base64.b64decode(body.data, validate=True)
    except binascii.Error as e:
        raise HTTPException(400, "无效的 Base64 图片数据") from e
    try:
        image_hash = await local_storage.save_image(project_id, png_bytes)
    except ValueError as e:
        raise HTTPException(404, "项目不存在") from e
    return {"hash": image_hash}


@router.get("/{project_id}/images/{image_hash}.png")
async def get_project_image(
    project_id: str, image_hash: str, _user: LocalUser = Depends(get_current_user),
):
    _assert_image_hash(image_hash)
    proj = await local_storage.get_project(project_id)
    if not proj:
        raise HTTPException(404, "项目不存在")

    data = await local_storage.load_image(project_id, image_hash)
    if data is None:
        raise HTTPException(404, "图片不存在")

    return Response(
        content=data,
        media_type="image/png",
        headers={
            "Cache-Control": "public, max-age=86400, immutable",
        },
    )


@router.put("/{project_id}/images/{image_hash}")
async def put_project_image(
    project_id: str,
    image_hash: str,
    body: ImageUploadRequest,
    _user: LocalUser = Depends(get_current_user),
):
    _assert_image_hash(image_hash)
    proj = await local_storage.get_project(project_id)
    if not proj:
        raise HTTPException(404, "项目不存在")

    try:
        png_bytes = base64.b64decode(body.data, validate=True)
    except binascii.Error as e:
        raise HTTPException(400, "无效的 Base64 图片数据") from e

    digest = hashlib.sha256(png_bytes).hexdigest()
    if digest.lower() != image_hash.lower():
        raise HTTPException(400, "图片哈希与内容不匹配")

    try:
        await local_storage.save_image(project_id, png_bytes)
    except ValueError as e:
        raise HTTPException(404, "项目不存在") from e
    return {"ok": True}


@router.delete("/{project_id}")
async def delete_project(project_id: str, _user: LocalUser = Depends(get_current_user)):
    proj = await local_storage.get_project(project_id)
    if not proj:
        raise HTTPException(404, "项目不存在")
    ok = await local_storage.delete_project(project_id)
    if not ok:
        raise HTTPException(404, "项目不存在")
    return {"ok": True}
