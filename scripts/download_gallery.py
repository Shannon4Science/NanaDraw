#!/usr/bin/env python3
"""Download Gallery reference images from PaperGallery GitHub repository.

The gallery images live on the `web` branch of PaperGallery under
public/images/pipeline/.  We shallow-clone that branch and copy
the pipeline images into backend/static/gallery/.
"""

import subprocess
import shutil
import sys
from pathlib import Path

REPO_URL = "https://github.com/LongHZ140516/PaperGallery.git"
BRANCH = "web"
IMAGE_SUBDIR = "public/images/pipeline"
GALLERY_DIR = Path(__file__).resolve().parent.parent / "backend" / "static" / "gallery"


def main():
    import tempfile
    with tempfile.TemporaryDirectory() as tmpdir:
        print(f"\nCloning {REPO_URL} (branch: {BRANCH}) ...")
        subprocess.run(
            ["git", "clone", "--depth", "1", "--branch", BRANCH, REPO_URL, tmpdir],
            check=True,
        )

        src_dir = Path(tmpdir) / IMAGE_SUBDIR
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
