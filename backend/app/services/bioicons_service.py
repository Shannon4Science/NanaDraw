"""Bioicons SVG library from local static files only."""

from __future__ import annotations

import json
import logging
from pathlib import Path

from app.schemas.paper import BioiconCategory, BioiconItem

logger = logging.getLogger(__name__)

BIOICONS_DIR = Path(__file__).resolve().parent.parent.parent / "static" / "bioicons"
METADATA_PATH = BIOICONS_DIR / "metadata.json"
SVG_DIR = BIOICONS_DIR / "svgs"
LIB_DIR = BIOICONS_DIR / "libs"


class BioiconsService:
    def __init__(self) -> None:
        self._categories: list[BioiconCategory] = []
        self._icons: list[dict] = []
        self._icons_by_category: dict[str, list[dict]] = {}
        self._icons_by_id: dict[str, dict] = {}
        self._loaded = False
        self._svg_cache: dict[str, bytes] = {}

    def _load(self) -> None:
        if self._loaded:
            return
        if not METADATA_PATH.exists():
            logger.warning("bioicons metadata.json not found: %s", METADATA_PATH)
            self._loaded = True
            return
        self._parse_metadata(METADATA_PATH.read_text(encoding="utf-8"))

    async def _ensure_loaded(self) -> None:
        self._load()

    def _parse_metadata(self, raw: str) -> None:
        data = json.loads(raw)
        self._categories = [BioiconCategory(**c) for c in data.get("categories", [])]
        self._icons = data.get("icons", [])
        self._icons_by_category.clear()
        self._icons_by_id.clear()
        for icon in self._icons:
            cat = icon["category"]
            self._icons_by_category.setdefault(cat, []).append(icon)
            self._icons_by_id[icon["id"]] = icon
        logger.info("Loaded %d bioicons in %d categories", len(self._icons), len(self._categories))
        self._loaded = True

    def list_categories(self) -> list[BioiconCategory]:
        self._load()
        return self._categories

    async def list_categories_async(self) -> list[BioiconCategory]:
        await self._ensure_loaded()
        return self._categories

    def list_icons(
        self,
        category: str | None = None,
        query: str | None = None,
        page: int = 1,
        limit: int = 60,
    ) -> tuple[list[BioiconItem], int]:
        self._load()
        return self._build_page(category, query, page, limit)

    async def list_icons_async(
        self,
        category: str | None = None,
        query: str | None = None,
        page: int = 1,
        limit: int = 60,
    ) -> tuple[list[BioiconItem], int]:
        await self._ensure_loaded()
        return self._build_page(category, query, page, limit)

    def _build_page(
        self, category: str | None = None, query: str | None = None, page: int = 1, limit: int = 60,
    ) -> tuple[list[BioiconItem], int]:
        if category:
            pool = self._icons_by_category.get(category, [])
        else:
            pool = self._icons

        if query:
            q = query.lower()
            pool = [
                ic for ic in pool
                if q in ic["name"].lower()
                or q in ic["category"].lower()
                or q in ic["author"].lower()
            ]

        total = len(pool)
        start = (page - 1) * limit
        page_items = pool[start : start + limit]

        items = [
            BioiconItem(
                id=ic["id"],
                name=ic["name"],
                category=ic["category"],
                author=ic["author"],
                license=ic["license"],
                svg_url=f"/api/v1/bioicons/icon/{ic['id']}/svg",
                w=ic["w"],
                h=ic["h"],
            )
            for ic in page_items
        ]
        return items, total

    def _resolve_svg_path(self, ic: dict) -> Path | None:
        """Try to locate the SVG file, accounting for optional license sub-directory."""
        svg_rel = ic.get("svg_path", "")
        if not svg_rel:
            return None
        direct = SVG_DIR / svg_rel
        if direct.is_file():
            return direct
        lic = ic.get("license", "")
        if lic:
            via_license = SVG_DIR / lic / svg_rel
            if via_license.is_file():
                return via_license
        return None

    async def get_svg_content(self, icon_id: str) -> bytes | None:
        await self._ensure_loaded()
        ic = self._icons_by_id.get(icon_id)
        if ic is None:
            return None

        if icon_id in self._svg_cache:
            return self._svg_cache[icon_id]

        local_path = self._resolve_svg_path(ic)
        if local_path is not None:
            data = local_path.read_bytes()
            self._svg_cache[icon_id] = data
            return data

        return None

    async def get_library_xml(self, category: str) -> str | None:
        lib_name = f"Bioicons-{category.replace(' ', '_')}.xml"
        lib_path = LIB_DIR / lib_name
        if lib_path.is_file():
            return lib_path.read_text(encoding="utf-8")
        return None
