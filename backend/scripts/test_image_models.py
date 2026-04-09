#!/usr/bin/env python3
"""Connectivity test for primary and backup image generation models.

Usage:
    cd backend && python -m scripts.test_image_models

Tests both the primary OpenAI-compatible image model and the fal.ai backup model.
Prints timing and result info for each.
"""

import asyncio
import base64
import os
import sys
import time

import httpx

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from app.core.config import settings

TEST_PROMPT = "A simple blue circle icon on white background, minimal flat design"


async def test_primary():
    """Test primary image model via OpenAI-compatible API."""
    api_keys = [k.strip() for k in settings.LLM_API_KEY.split(",") if k.strip()]
    if not api_keys:
        print("[PRIMARY] SKIP - no LLM_API_KEY configured")
        return

    print(f"[PRIMARY] model={settings.LLM_IMAGE_MODEL}")
    print(f"[PRIMARY] base_url={settings.LLM_BASE_URL}")

    body = {
        "model": settings.LLM_IMAGE_MODEL,
        "messages": [
            {"role": "system", "content": "Generate a simple icon image."},
            {"role": "user", "content": TEST_PROMPT},
        ],
        "temperature": 0.8,
    }
    headers = {
        "Authorization": f"Bearer {api_keys[0]}",
        "Content-Type": "application/json",
    }
    timeout = httpx.Timeout(connect=10.0, read=300.0, write=10.0, pool=10.0)

    t0 = time.monotonic()
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                f"{settings.LLM_BASE_URL}/chat/completions",
                json=body, headers=headers, timeout=timeout,
            )
            elapsed = time.monotonic() - t0
            print(f"[PRIMARY] status={resp.status_code} elapsed={elapsed:.1f}s")
            if resp.status_code == 200:
                data = resp.json()
                content = data.get("choices", [{}])[0].get("message", {}).get("content", "")
                has_image = "base64" in str(content)[:500] or (isinstance(content, list) and any(
                    p.get("type") in ("image_url", "image") for p in content if isinstance(p, dict)
                ))
                print(f"[PRIMARY] {'OK - image found' if has_image else 'WARN - no image in response'}")
                print(f"[PRIMARY] content preview: {str(content)[:200]}")
            else:
                print(f"[PRIMARY] ERROR: {resp.text[:500]}")
    except Exception as e:
        elapsed = time.monotonic() - t0
        print(f"[PRIMARY] FAILED ({type(e).__name__}): {e} [{elapsed:.1f}s]")


async def test_fal_backup():
    """Test fal.ai backup model."""
    fal_key = settings.FAL_API_KEY
    model = settings.LLM_IMAGE_MODEL_BACKUP
    if not fal_key:
        print("[BACKUP] SKIP - no FAL_API_KEY configured")
        return
    if not model:
        print("[BACKUP] SKIP - no LLM_IMAGE_MODEL_BACKUP configured")
        return

    print(f"[BACKUP] model={model}")
    url = f"https://fal.run/{model}"
    body = {
        "prompt": TEST_PROMPT,
        "num_images": 1,
        "output_format": "png",
        "resolution": "0.5K",
        "aspect_ratio": "1:1",
        "sync_mode": True,
    }
    headers = {
        "Authorization": f"Key {fal_key}",
        "Content-Type": "application/json",
    }
    timeout = httpx.Timeout(connect=15.0, read=120.0, write=15.0, pool=15.0)

    t0 = time.monotonic()
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post(url, json=body, headers=headers, timeout=timeout)
            elapsed = time.monotonic() - t0
            print(f"[BACKUP] status={resp.status_code} elapsed={elapsed:.1f}s")
            if resp.status_code == 200:
                data = resp.json()
                images = data.get("images", [])
                if images:
                    img_url = images[0].get("url", "")
                    print(f"[BACKUP] OK - image URL prefix: {img_url[:80]}...")
                    # Handle data URI (sync_mode=True returns base64 directly)
                    if img_url.startswith("data:"):
                        if ";base64," in img_url:
                            b64_data = img_url.split(";base64,", 1)[1]
                            size_kb = len(b64_data) * 3 / 4 / 1024
                            print(f"[BACKUP] Data URI - estimated {size_kb:.0f}KB image (base64 inline)")
                        else:
                            print(f"[BACKUP] WARN - unsupported data URI format")
                    else:
                        img_resp = await client.get(img_url, timeout=httpx.Timeout(30.0))
                        size_kb = len(img_resp.content) / 1024
                        print(f"[BACKUP] Downloaded {size_kb:.0f}KB image")
                else:
                    print(f"[BACKUP] WARN - no images in response: {str(data)[:300]}")
            else:
                print(f"[BACKUP] ERROR: {resp.text[:500]}")
    except Exception as e:
        elapsed = time.monotonic() - t0
        print(f"[BACKUP] FAILED ({type(e).__name__}): {e} [{elapsed:.1f}s]")


async def main():
    print("=" * 60)
    print("Image Model Connectivity Test")
    print("=" * 60)
    await test_primary()
    print()
    await test_fal_backup()
    print("=" * 60)
    print("Done.")


if __name__ == "__main__":
    asyncio.run(main())
