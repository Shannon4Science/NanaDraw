"""API endpoints for bioicons SVG library."""

from fastapi import APIRouter, HTTPException, Query, Response

from app.schemas.paper import BioiconCategory
from app.services.bioicons_service import BioiconsService

router = APIRouter()
bioicons_service = BioiconsService()

_SVG_CACHE_HEADER = "public, max-age=86400, immutable"


@router.get("/bioicons/categories", response_model=list[BioiconCategory])
async def list_bioicon_categories() -> list[BioiconCategory]:
    return await bioicons_service.list_categories_async()


@router.get("/bioicons/icons")
async def list_bioicons(
    category: str | None = Query(None),
    q: str | None = Query(None),
    page: int = Query(1, ge=1),
    limit: int = Query(60, ge=1, le=200),
) -> dict:
    items, total = await bioicons_service.list_icons_async(category=category, query=q, page=page, limit=limit)
    return {"items": items, "total": total, "page": page, "limit": limit}


@router.get("/bioicons/icon/{icon_id}/svg")
async def get_bioicon_svg(icon_id: str) -> Response:
    svg_bytes = await bioicons_service.get_svg_content(icon_id)
    if svg_bytes is None:
        raise HTTPException(status_code=404, detail="Icon not found")
    return Response(
        content=svg_bytes,
        media_type="image/svg+xml",
        headers={"Cache-Control": _SVG_CACHE_HEADER},
    )


@router.get("/bioicons/library/{category}")
async def get_bioicon_library(category: str) -> Response:
    """Return <mxlibrary> XML for draw.io sidebar lazy-loading."""
    xml_content = await bioicons_service.get_library_xml(category)
    if xml_content is None:
        raise HTTPException(status_code=404, detail=f"Library not found for category: {category}")
    return Response(
        content=xml_content,
        media_type="application/xml",
        headers={"Access-Control-Allow-Origin": "*", "Cache-Control": _SVG_CACHE_HEADER},
    )
