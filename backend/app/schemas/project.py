"""Project schemas (local storage, no DB-specific fields)."""

from typing import Literal

from pydantic import BaseModel, Field


class ProjectCreate(BaseModel):
    name: str = Field(default="未命名项目", max_length=128)
    canvas_type: str = Field(default="drawio", pattern="^drawio$")


class ProjectUpdate(BaseModel):
    name: str | None = Field(default=None, max_length=128)
    canvas_type: str | None = Field(default=None, pattern="^drawio$")


class ProjectInfo(BaseModel):
    id: str
    name: str
    canvas_type: str
    status: str = "active"
    thumbnail_url: str | None = None
    created_at: str | None = None
    updated_at: str | None = None


class ProjectDetail(ProjectInfo):
    drawio_url: str | None = None


class ProjectListResponse(BaseModel):
    projects: list[ProjectInfo]
    total: int
    page: int
    page_size: int


class CanvasSaveRequest(BaseModel):
    canvas_data: str = Field(..., description="XML or JSON canvas data")
    canvas_encoding: Literal["plain", "gzip_b64", "deflate_b64"] = Field(
        default="plain", description="Encoding of canvas_data",
    )
    thumbnail_b64: str | None = Field(default=None, description="Base64 PNG thumbnail")


class ImageUploadRequest(BaseModel):
    data: str = Field(..., description="Base64 encoded PNG image data")


class ImageBatchGetRequest(BaseModel):
    hashes: list[str] = Field(..., description="List of SHA-256 hashes to fetch")
