#!/usr/bin/env python3
"""Download Gallery reference images from PaperGallery GitHub repository.

The gallery images live on the `web` branch of PaperGallery under
public/images/pipeline/.  We shallow-clone that branch and copy
the pipeline images into backend/static/gallery/.
"""

import subprocess
import shutil
import sys
import time
import zipfile
import urllib.request
from pathlib import Path

REPO_URL = "https://github.com/LongHZ140516/PaperGallery.git"
BRANCH = "web"
IMAGE_SUBDIR = "public/images/pipeline"
GALLERY_DIR = Path(__file__).resolve().parent.parent / "backend" / "static" / "gallery"
ZIP_URL = f"https://codeload.github.com/LongHZ140516/PaperGallery/zip/refs/heads/{BRANCH}"


def clone_repo(target_dir: str) -> bool:
    """Try shallow clone with retries to tolerate transient network issues."""
    cmd = ["git", "clone", "--depth", "1", "--branch", BRANCH, REPO_URL, target_dir]
    for attempt in range(1, 4):
        try:
            print(f"Clone attempt {attempt}/3 ...")
            subprocess.run(cmd, check=True)
            return True
        except subprocess.CalledProcessError as e:
            if attempt == 3:
                print(f"Git clone failed after 3 attempts: {e}")
                return False
            sleep_s = attempt * 2
            print(f"Clone failed, retrying in {sleep_s}s ...")
            time.sleep(sleep_s)
    return False


def download_zip_and_extract(target_dir: str) -> Path:
    """Fallback: download branch zip from codeload and extract."""
    zip_path = Path(target_dir) / "papergallery.zip"
    print(f"Falling back to ZIP download: {ZIP_URL}")
    urllib.request.urlretrieve(ZIP_URL, zip_path)
    with zipfile.ZipFile(zip_path, "r") as zf:
        zf.extractall(target_dir)
    extracted = Path(target_dir) / f"PaperGallery-{BRANCH}"
    if not extracted.exists():
        raise FileNotFoundError(f"Extracted folder not found: {extracted}")
    return extracted


def main():
    import tempfile
    with tempfile.TemporaryDirectory() as tmpdir:
        print(f"\nCloning {REPO_URL} (branch: {BRANCH}) ...")
        repo_root = Path(tmpdir)
        if not clone_repo(tmpdir):
            repo_root = download_zip_and_extract(tmpdir)

        src_dir = repo_root / IMAGE_SUBDIR
        if not src_dir.exists():
            print(f"ERROR: {IMAGE_SUBDIR} not found in repository!")
            sys.exit(1)

        image_files = (
            list(src_dir.glob("*.png"))
            + list(src_dir.glob("*.jpg"))
            + list(src_dir.glob("*.jpeg"))
            + list(src_dir.glob("*.JPG"))
        )

        if not image_files:
            print("No image files found in repository!")
            sys.exit(1)

        GALLERY_DIR.mkdir(parents=True, exist_ok=True)

        copied = 0
        skipped = 0
        for f in image_files:
            dest = GALLERY_DIR / f.name
            if not dest.exists():
                shutil.copy2(f, dest)
                copied += 1
            else:
                skipped += 1

        total = len(list(GALLERY_DIR.glob("*.png")) + list(GALLERY_DIR.glob("*.jpg")) + list(GALLERY_DIR.glob("*.jpeg")))
        print(f"✓ Copied {copied} new images to {GALLERY_DIR}")
        if skipped:
            print(f"  Skipped {skipped} already existing")
        print(f"  Total images: {total}")


if __name__ == "__main__":
    main()
