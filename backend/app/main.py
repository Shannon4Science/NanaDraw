import logging
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.api.v1.router import api_router

logger = logging.getLogger(__name__)

app = FastAPI(title="NanaDraw", docs_url="/api/docs", redoc_url=None)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(api_router, prefix="/api/v1")


@app.get("/health")
async def health_check() -> dict[str, str]:
    return {"status": "ok"}


BACKEND_DIR = Path(__file__).resolve().parent.parent
PROJECT_ROOT = BACKEND_DIR.parent
FRONTEND_DIST = PROJECT_ROOT / "frontend" / "dist"
STATIC_DIR = BACKEND_DIR / "static"

if STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

if FRONTEND_DIST.exists():
    assets_dir = FRONTEND_DIST / "assets"
    if assets_dir.exists():
        app.mount("/assets", StaticFiles(directory=str(assets_dir)), name="frontend-assets")

    drawio_dir = FRONTEND_DIST / "drawio"
    if drawio_dir.exists():
        app.mount("/drawio", StaticFiles(directory=str(drawio_dir), html=True), name="drawio")

    @app.get("/{path:path}")
    async def spa_catch_all(path: str):
        file_path = FRONTEND_DIST / path
        if file_path.exists() and file_path.is_file():
            return FileResponse(str(file_path))
        return FileResponse(str(FRONTEND_DIST / "index.html"))
else:
    logger.warning(
        "Frontend dist not found at %s — run 'pnpm build' first",
        FRONTEND_DIST,
    )

    @app.get("/")
    async def no_frontend():
        return {
            "message": "Frontend not built. Run start.py or cd frontend && pnpm build",
        }
