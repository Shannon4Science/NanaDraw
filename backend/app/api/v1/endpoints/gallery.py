from fastapi import APIRouter, HTTPException, Query

from app.schemas.paper import GallerySearchResult, StyleReference
from app.services.gallery_service import get_gallery_service

router = APIRouter()
gallery_service = get_gallery_service()


@router.get("/gallery/search", response_model=list[GallerySearchResult])
async def search_gallery(
    q: str = Query(..., min_length=1, description="Search query text"),
    top_k: int = Query(10, ge=1, le=50),
) -> list[GallerySearchResult]:
    """Semantic search gallery items by query text."""
    return await gallery_service.search(q, top_k)


@router.get("/gallery", response_model=list[StyleReference])
async def list_gallery(category: str | None = None) -> list[StyleReference]:
    """List style reference images from the gallery."""
    return gallery_service.list_all(category)


@router.get("/gallery/{ref_id}", response_model=StyleReference)
async def get_gallery_item(ref_id: str) -> StyleReference:
    """Get a specific style reference by ID."""
    item = gallery_service.get_by_id(ref_id)
    if not item:
        raise HTTPException(status_code=404, detail="Style reference not found")
    return item
