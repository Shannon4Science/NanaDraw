"""Style reference gallery: keyword search over local gallery.json (singleton)."""

from __future__ import annotations

import json
import logging
from pathlib import Path

from app.schemas.paper import GallerySearchResult, StyleReference

logger = logging.getLogger(__name__)

GALLERY_DATA_PATH = Path(__file__).parent.parent.parent / "static" / "gallery" / "gallery.json"

_instance: GalleryService | None = None


def get_gallery_service() -> GalleryService:
    global _instance
    if _instance is None:
        _instance = GalleryService()
    return _instance


class GalleryService:
    def __init__(self) -> None:
        self._items: list[StyleReference] = []
        self._by_id: dict[str, StyleReference] = {}
        self._load()

    def _load(self) -> None:
        if not GALLERY_DATA_PATH.exists():
            logger.warning("Gallery data file not found: %s", GALLERY_DATA_PATH)
            return
        raw = json.loads(GALLERY_DATA_PATH.read_text(encoding="utf-8"))
        self._items = [StyleReference.model_validate(item) for item in raw]
        self._by_id = {item.id: item for item in self._items}

    def list_all(self, category: str | None = None) -> list[StyleReference]:
        if category:
            return [item for item in self._items if item.category == category]
        return self._items

    def get_by_id(self, ref_id: str) -> StyleReference | None:
        return self._by_id.get(ref_id)

    async def search(self, query: str, top_k: int = 10) -> list[GallerySearchResult]:
        return self._keyword_search(query, top_k)

    def _keyword_search(self, query: str, top_k: int) -> list[GallerySearchResult]:
        q = query.lower()
        scored: list[tuple[float, StyleReference]] = []
        for item in self._items:
            score = 0.0
            tags = " ".join(item.tags)
            searchable = (
                f"{item.name} {item.title} {tags} {item.abstract} {item.style_description}"
            ).lower()
            for word in q.split():
                if word in searchable:
                    score += 1.0
            if score > 0:
                scored.append((score, item))

        scored.sort(key=lambda x: x[0], reverse=True)
        return [
            GallerySearchResult(**item.model_dump(), score=round(sc, 4))
            for sc, item in scored[:top_k]
        ]
