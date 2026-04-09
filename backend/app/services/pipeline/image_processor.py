"""Image cropping and background removal for element extraction."""

import asyncio
import base64
import io
import logging
from collections import deque

import numpy as np
from PIL import Image

logger = logging.getLogger(__name__)

# Safety margin (px) added around content after crop-to-bbox.
# Prevents border clipping from anti-aliased edges and rembg imprecision.
_CROP_PADDING = 4

# Checkerboard detection thresholds
_CHECKER_GRID_SIZES = (8, 10, 12, 16, 20, 24, 32, 40, 48, 6, 4)
_CHECKER_MIN_COVERAGE = 0.08
_CHECKER_MAX_CH_DIFF = 20
_CHECKER_TONE_STD_MAX = 20
_CHECKER_TONE_GAP_MIN = 20


class ImageProcessor:
    """Process reference images: crop elements, remove backgrounds, check quality."""

    @staticmethod
    def b64_to_image(b64: str) -> Image.Image:
        return Image.open(io.BytesIO(base64.b64decode(b64)))

    @staticmethod
    def image_to_b64(img: Image.Image, fmt: str = "PNG") -> str:
        buf = io.BytesIO()
        img.save(buf, format=fmt)
        return base64.b64encode(buf.getvalue()).decode()

    @staticmethod
    def _crop_to_content_padded(img: Image.Image, padding: int = _CROP_PADDING) -> Image.Image:
        """Crop to non-transparent content bbox with a safety margin.

        The padding preserves anti-aliased border edges that would otherwise
        be clipped by a zero-margin getbbox() crop.
        """
        bbox = img.getbbox()
        if not bbox:
            return img
        left, top, right, bottom = bbox
        w, h = img.size
        padded = (
            max(0, left - padding),
            max(0, top - padding),
            min(w, right + padding),
            min(h, bottom + padding),
        )
        return img.crop(padded)

    @staticmethod
    def content_bbox_ratios(image_b64: str) -> tuple[float, float, float, float]:
        """Return (x_ratio, y_ratio, w_ratio, h_ratio) of actual content within the image.

        Uses the alpha channel to find the non-transparent bounding box,
        then returns its position and size as fractions of the full image.
        If content fills >=95% of the canvas, returns (0, 0, 1, 1) to skip adjustment.
        """
        img = ImageProcessor.b64_to_image(image_b64).convert("RGBA")
        bbox = img.getbbox()
        if not bbox:
            return (0.0, 0.0, 1.0, 1.0)
        iw, ih = img.size
        if iw <= 0 or ih <= 0:
            return (0.0, 0.0, 1.0, 1.0)
        left, top, right, bottom = bbox
        cw = right - left
        ch = bottom - top
        if cw >= iw * 0.95 and ch >= ih * 0.95:
            return (0.0, 0.0, 1.0, 1.0)
        return (left / iw, top / ih, cw / iw, ch / ih)

    @staticmethod
    def _neutralize_checkerboard(img: Image.Image) -> Image.Image:
        """Replace checkerboard transparency pattern with solid white.

        Some image generators render a gray/white checkerboard grid instead of
        true alpha transparency. We detect the two-tone alternating grid pattern
        and replace matching pixels with white, so rembg can cleanly remove them.
        """
        arr = np.array(img)
        h, w = arr.shape[:2]
        if h < 32 or w < 32:
            return img

        rgb = arr[:, :, :3].astype(np.int16)
        r, g, b = rgb[:, :, 0], rgb[:, :, 1], rgb[:, :, 2]
        max_ch_diff = np.maximum(np.abs(r - g), np.maximum(np.abs(g - b), np.abs(r - b)))
        brightness = r.astype(np.float32)

        is_gray = max_ch_diff < _CHECKER_MAX_CH_DIFF
        if arr.shape[2] == 4:
            is_gray = is_gray & (arr[:, :, 3] > 200)

        # Detection candidates include BOTH tones (gray ~150-210 AND white ~240-255)
        is_checker_zone = is_gray & (brightness > 150)
        zone_ratio = float(is_checker_zone.sum()) / (h * w)
        if zone_ratio < _CHECKER_MIN_COVERAGE:
            return img

        yr = np.arange(h)
        xr = np.arange(w)
        for gs in _CHECKER_GRID_SIZES:
            if h < gs * 4 or w < gs * 4:
                continue
            parity = ((yr[:, None] // gs) + (xr[None, :] // gs)) % 2
            mask0 = is_checker_zone & (parity == 0)
            mask1 = is_checker_zone & (parity == 1)
            n0, n1 = int(mask0.sum()), int(mask1.sum())
            if n0 < 50 or n1 < 50:
                continue
            m0, s0 = float(brightness[mask0].mean()), float(brightness[mask0].std())
            m1, s1 = float(brightness[mask1].mean()), float(brightness[mask1].std())
            if s0 < _CHECKER_TONE_STD_MAX and s1 < _CHECKER_TONE_STD_MAX and abs(m0 - m1) > _CHECKER_TONE_GAP_MIN:
                # Replace the darker tone with white (lighter tone is already ~white)
                darker_parity = 0 if m0 < m1 else 1
                to_whiten = is_checker_zone & (parity == darker_parity)
                arr[to_whiten, 0] = 255
                arr[to_whiten, 1] = 255
                arr[to_whiten, 2] = 255
                logger.info(
                    "Neutralized checkerboard (grid=%d, tones=%.0f/%.0f, coverage=%.0f%%)",
                    gs, m0, m1, zone_ratio * 100,
                )
                return Image.fromarray(arr, img.mode)

        return img

    @staticmethod
    async def remove_background_rembg(image_b64: str, crop: bool = True) -> str:
        """Remove background using rembg (U2-Net deep learning model).

        Returns base64 RGBA PNG with transparent background.
        Runs in a thread pool to avoid blocking the event loop.
        When crop=False, the original canvas dimensions are preserved.
        """
        def _sync_remove():
            session = _get_rembg_session()
            from rembg import remove as rembg_remove
            img = ImageProcessor.b64_to_image(image_b64).convert("RGBA")
            result = rembg_remove(img, session=session, post_process_mask=True)
            if crop:
                result = ImageProcessor._crop_to_content_padded(result)
            return ImageProcessor.image_to_b64(result)

        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, _sync_remove)

    @staticmethod
    def _edge_flood_remove_bg(img: Image.Image, threshold: int = 240) -> Image.Image:
        """Remove background via edge-connected flood fill.

        Only removes near-white pixels reachable from the image border,
        preserving interior fills inside bounding shapes. This prevents
        rembg from destroying the fill color inside a component's border.
        """
        arr = np.array(img.convert("RGBA"))
        h, w = arr.shape[:2]

        rgb = arr[:, :, :3].astype(np.int16)
        is_white = (
            (rgb[:, :, 0] >= threshold)
            & (rgb[:, :, 1] >= threshold)
            & (rgb[:, :, 2] >= threshold)
        )

        visited = np.zeros((h, w), dtype=bool)
        queue: deque[tuple[int, int]] = deque()

        for x in range(w):
            if is_white[0, x] and not visited[0, x]:
                queue.append((0, x))
                visited[0, x] = True
            if is_white[h - 1, x] and not visited[h - 1, x]:
                queue.append((h - 1, x))
                visited[h - 1, x] = True
        for y in range(h):
            if is_white[y, 0] and not visited[y, 0]:
                queue.append((y, 0))
                visited[y, 0] = True
            if is_white[y, w - 1] and not visited[y, w - 1]:
                queue.append((y, w - 1))
                visited[y, w - 1] = True

        while queue:
            cy, cx = queue.popleft()
            for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1)):
                ny, nx = cy + dy, cx + dx
                if 0 <= ny < h and 0 <= nx < w and not visited[ny, nx] and is_white[ny, nx]:
                    visited[ny, nx] = True
                    queue.append((ny, nx))

        arr[visited, 3] = 0

        removed_count = int(visited.sum())
        total = h * w
        logger.info(
            "Edge-flood bg removal: %d/%d pixels (%.1f%%) made transparent",
            removed_count, total, removed_count / total * 100,
        )
        return Image.fromarray(arr, "RGBA")

    @staticmethod
    async def ensure_transparent(
        image_b64: str,
        opaque_threshold: float = 0.92,
        crop: bool = True,
        prefer_edge_flood: bool = False,
        disable_rembg_fallback: bool = False,
    ) -> str:
        """Ensure the image has a transparent background.

        If the LLM already generated a transparent PNG (enough alpha variation),
        optionally crop to content and return. Otherwise neutralize any
        checkerboard pattern, then apply background removal.

        When prefer_edge_flood=True, uses edge-connected flood fill instead of
        rembg. This preserves interior fills inside bounding shapes (borders)
        and only removes white pixels connected to the image edges.
        When disable_rembg_fallback=True, never fall back to rembg even if
        edge-flood leaves many opaque edge pixels. This prevents rembg from
        removing white content inside the subject (e.g. white faces).
        When crop=False, the original canvas dimensions are preserved.
        """
        img = ImageProcessor.b64_to_image(image_b64).convert("RGBA")
        alpha = img.split()[3]
        total = alpha.size[0] * alpha.size[1]
        opaque_count = sum(1 for p in alpha.getdata() if p > 250)
        opaque_ratio = opaque_count / total if total > 0 else 1.0

        if opaque_ratio < opaque_threshold:
            logger.info(
                "Image already has transparency (opaque=%.1f%%), skipping bg removal",
                opaque_ratio * 100,
            )
            if crop:
                img = ImageProcessor._crop_to_content_padded(img)
            return ImageProcessor.image_to_b64(img)

        img = ImageProcessor._neutralize_checkerboard(img)

        if prefer_edge_flood:
            logger.info(
                "Image mostly opaque (%.1f%%), using edge-flood removal (border-safe)",
                opaque_ratio * 100,
            )
            result = ImageProcessor._edge_flood_remove_bg(img)

            r_alpha = result.split()[3]
            r_h, r_w = result.size[1], result.size[0]
            edge_pixels = []
            for ex in range(r_w):
                edge_pixels.append(r_alpha.getpixel((ex, 0)))
                edge_pixels.append(r_alpha.getpixel((ex, r_h - 1)))
            for ey in range(r_h):
                edge_pixels.append(r_alpha.getpixel((0, ey)))
                edge_pixels.append(r_alpha.getpixel((r_w - 1, ey)))
            opaque_edge = sum(1 for p in edge_pixels if p > 200)
            edge_opaque_ratio = opaque_edge / max(1, len(edge_pixels))

            if edge_opaque_ratio > 0.3:
                if disable_rembg_fallback:
                    logger.warning(
                        "Edge-flood left %.1f%% opaque edge pixels — "
                        "keeping result (rembg fallback disabled)",
                        edge_opaque_ratio * 100,
                    )
                else:
                    logger.warning(
                        "Edge-flood left %.1f%% opaque edge pixels — falling back to rembg",
                        edge_opaque_ratio * 100,
                    )
                    cleaned_b64 = ImageProcessor.image_to_b64(img)
                    return await ImageProcessor.remove_background_rembg(cleaned_b64, crop=crop)

            if crop:
                result = ImageProcessor._crop_to_content_padded(result)
            return ImageProcessor.image_to_b64(result)

        if disable_rembg_fallback:
            logger.info(
                "Image mostly opaque (%.1f%%), rembg disabled — using edge-flood as fallback",
                opaque_ratio * 100,
            )
            result = ImageProcessor._edge_flood_remove_bg(img)
            if crop:
                result = ImageProcessor._crop_to_content_padded(result)
            return ImageProcessor.image_to_b64(result)

        cleaned_b64 = ImageProcessor.image_to_b64(img)
        logger.info(
            "Image is mostly opaque (%.1f%%), applying rembg fallback",
            opaque_ratio * 100,
        )
        return await ImageProcessor.remove_background_rembg(cleaned_b64, crop=crop)

    @staticmethod
    def crop_to_content(image_b64: str) -> str:
        """Crop transparent edges to content bounding box. No background removal."""
        img = ImageProcessor.b64_to_image(image_b64).convert("RGBA")
        alpha = img.split()[3]
        total = alpha.size[0] * alpha.size[1]
        opaque_count = sum(1 for p in alpha.getdata() if p > 250)
        opaque_ratio = opaque_count / total if total > 0 else 1.0

        if opaque_ratio < 0.97:
            img = ImageProcessor._crop_to_content_padded(img)
            logger.info(
                "crop_to_content: image has transparency (opaque=%.1f%%), cropped to content",
                opaque_ratio * 100,
            )
        else:
            logger.info(
                "crop_to_content: image is mostly opaque (%.1f%%), using as-is",
                opaque_ratio * 100,
            )
        return ImageProcessor.image_to_b64(img)

    @staticmethod
    def detect_separator_artifact(image_b64: str) -> str:
        """Detect and remove residual separator lines from component images.

        Scans for the "sandwich" pattern: transparent band — thin opaque band —
        transparent band along horizontal or vertical axis. If found, crops the
        image to the larger content region (the side with more opaque pixels).
        """
        img = ImageProcessor.b64_to_image(image_b64).convert("RGBA")
        alpha = np.array(img.split()[3])
        h, w = alpha.shape
        if h < 10 or w < 10:
            return image_b64

        opaque_thresh = 30
        band_max_thickness = max(6, min(h, w) // 30)

        def _find_separator_rows() -> tuple[int, int] | None:
            row_opaque = np.sum(alpha > opaque_thresh, axis=1)
            row_ratio = row_opaque / w
            for start in range(h):
                if row_ratio[start] < 0.5:
                    continue
                end = start
                while end < h and row_ratio[end] >= 0.5:
                    end += 1
                thickness = end - start
                if thickness > band_max_thickness:
                    start = end
                    continue
                top_ok = start <= 3 or (
                    start > 3 and np.mean(row_ratio[max(0, start - 5):start]) < 0.15
                )
                bot_ok = end >= h - 3 or (
                    end < h - 3 and np.mean(row_ratio[end:min(h, end + 5)]) < 0.15
                )
                if top_ok and bot_ok:
                    return (start, end)
            return None

        def _find_separator_cols() -> tuple[int, int] | None:
            col_opaque = np.sum(alpha > opaque_thresh, axis=0)
            col_ratio = col_opaque / h
            for start in range(w):
                if col_ratio[start] < 0.5:
                    continue
                end = start
                while end < w and col_ratio[end] >= 0.5:
                    end += 1
                thickness = end - start
                if thickness > band_max_thickness:
                    start = end
                    continue
                left_ok = start <= 3 or (
                    start > 3 and np.mean(col_ratio[max(0, start - 5):start]) < 0.15
                )
                right_ok = end >= w - 3 or (
                    end < w - 3 and np.mean(col_ratio[end:min(w, end + 5)]) < 0.15
                )
                if left_ok and right_ok:
                    return (start, end)
            return None

        sep_rows = _find_separator_rows()
        if sep_rows:
            start, end = sep_rows
            top_content = np.sum(alpha[:start] > opaque_thresh) if start > 0 else 0
            bot_content = np.sum(alpha[end:] > opaque_thresh) if end < h else 0
            if start <= 3:
                img = img.crop((0, end, w, h))
            elif end >= h - 3:
                img = img.crop((0, 0, w, start))
            elif top_content >= bot_content and start > 10:
                img = img.crop((0, 0, w, start))
            elif end < h - 10:
                img = img.crop((0, end, w, h))
            logger.info(
                "detect_separator_artifact: removed horizontal separator at rows %d-%d",
                start, end,
            )
            return ImageProcessor.crop_to_content(ImageProcessor.image_to_b64(img))

        sep_cols = _find_separator_cols()
        if sep_cols:
            start, end = sep_cols
            left_content = np.sum(alpha[:, :start] > opaque_thresh) if start > 0 else 0
            right_content = np.sum(alpha[:, end:] > opaque_thresh) if end < w else 0
            if start <= 3:
                img = img.crop((end, 0, w, h))
            elif end >= w - 3:
                img = img.crop((0, 0, start, h))
            elif left_content >= right_content and start > 10:
                img = img.crop((0, 0, start, h))
            elif end < w - 10:
                img = img.crop((end, 0, w, h))
            logger.info(
                "detect_separator_artifact: removed vertical separator at cols %d-%d",
                start, end,
            )
            return ImageProcessor.crop_to_content(ImageProcessor.image_to_b64(img))

        return image_b64

    @staticmethod
    def resize_contain(image_b64: str, target_w: int, target_h: int) -> str:
        """Resize image to fit within target dimensions while keeping aspect ratio.

        The result is centered on a transparent canvas of exactly target_w x target_h.
        If the source aspect ratio is close enough to the target (within 1.4x),
        a direct stretch is used instead to fill the cell completely.
        """
        img = ImageProcessor.b64_to_image(image_b64).convert("RGBA")
        src_w, src_h = img.size
        tw, th = max(1, target_w), max(1, target_h)

        src_ratio = src_w / max(1, src_h)
        tgt_ratio = tw / max(1, th)
        ratio_diff = max(src_ratio, tgt_ratio) / max(min(src_ratio, tgt_ratio), 0.01)

        if ratio_diff <= 1.4:
            img = img.resize((tw, th), Image.LANCZOS)
            return ImageProcessor.image_to_b64(img)

        scale = min(tw / max(1, src_w), th / max(1, src_h))
        new_w = max(1, int(src_w * scale))
        new_h = max(1, int(src_h * scale))
        resized = img.resize((new_w, new_h), Image.LANCZOS)

        canvas = Image.new("RGBA", (tw, th), (0, 0, 0, 0))
        canvas.paste(resized, ((tw - new_w) // 2, (th - new_h) // 2), resized)
        return ImageProcessor.image_to_b64(canvas)


    @staticmethod
    def rotate_image(image_b64: str, degrees: int) -> str:
        """Rotate image by 90/180/270 degrees counter-clockwise. Returns base64 PNG."""
        img = ImageProcessor.b64_to_image(image_b64).convert("RGBA")
        rotated = img.rotate(degrees, expand=True, resample=Image.BICUBIC)
        return ImageProcessor.image_to_b64(rotated)

    @staticmethod
    def flip_horizontal(image_b64: str) -> str:
        """Mirror image horizontally (left-right). Returns base64 PNG."""
        img = ImageProcessor.b64_to_image(image_b64).convert("RGBA")
        flipped = img.transpose(Image.FLIP_LEFT_RIGHT)
        return ImageProcessor.image_to_b64(flipped)

    @staticmethod
    def flip_vertical(image_b64: str) -> str:
        """Mirror image vertically (top-bottom). Returns base64 PNG."""
        img = ImageProcessor.b64_to_image(image_b64).convert("RGBA")
        flipped = img.transpose(Image.FLIP_TOP_BOTTOM)
        return ImageProcessor.image_to_b64(flipped)


_rembg_session = None


def _get_rembg_session():
    global _rembg_session
    if _rembg_session is None:
        from rembg import new_session
        logger.info("Loading rembg U2-Net session (first call, may download model)...")
        _rembg_session = new_session("u2net")
        logger.info("rembg session ready")
    return _rembg_session
