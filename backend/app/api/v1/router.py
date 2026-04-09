from fastapi import APIRouter

from app.api.v1.endpoints import (
    generate,
    gallery,
    bioicons,
    elements,
    projects,
    models,
    assistant,
    settings,
)

api_router = APIRouter()

api_router.include_router(generate.router)
api_router.include_router(gallery.router)
api_router.include_router(bioicons.router)
api_router.include_router(elements.router)
api_router.include_router(projects.router)
api_router.include_router(models.router)
api_router.include_router(assistant.router)
api_router.include_router(settings.router)
