from fastapi import APIRouter, Depends, File, HTTPException, UploadFile

from app.dependencies import require_auth
from app.services.mineru_service import MinerUError, parse_pdf_with_mineru
from app.services.settings_service import load_settings

router = APIRouter(prefix="/documents", tags=["documents"])

MAX_PDF_SIZE_BYTES = 200 * 1024 * 1024


@router.post("/parse-pdf")
async def parse_pdf(file: UploadFile = File(...), _user=Depends(require_auth)):
    file_name = file.filename or "document.pdf"
    if not file_name.lower().endswith(".pdf") and file.content_type != "application/pdf":
        raise HTTPException(status_code=400, detail="仅支持上传 PDF 文件")

    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="PDF 文件为空")
    if len(content) > MAX_PDF_SIZE_BYTES:
        raise HTTPException(status_code=413, detail="PDF 文件不能超过 200MB")

    token = str(load_settings().get("mineru_api_token", "")).strip()
    if not token:
        raise HTTPException(status_code=400, detail="请先在设置中配置 MinerU Token")

    try:
        return await parse_pdf_with_mineru(
            file_name=file_name,
            file_bytes=content,
            token=token,
        )
    except MinerUError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"PDF 解析失败: {exc}") from exc
