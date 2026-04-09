#!/usr/bin/env python3
"""Download Bioicons SVG files from the bioicons GitHub repository."""

import subprocess
import shutil
import sys
from pathlib import Path

REPO_URL = "https://github.com/duerrsimon/bioicons.git"
BIOICONS_DIR = Path(__file__).resolve().parent.parent / "backend" / "static" / "bioicons"

def main():
    import tempfile
    with tempfile.TemporaryDirectory() as tmpdir:
        print(f"Cloning {REPO_URL} ...")
        subprocess.run(
            ["git", "clone", "--depth", "1", REPO_URL, tmpdir],
            check=True,
        )
        
        repo = Path(tmpdir)
        
        # Copy SVGs
        svg_source = None
        for candidate in [repo / "static" / "icons", repo / "icons", repo / "svgs", repo / "static"]:
            if candidate.exists():
                svgs = list(candidate.rglob("*.svg"))
                if svgs:
                    svg_source = candidate
                    break
        
        if svg_source is None:
            print("No SVG source directory found!")
            # List repo structure for debugging
            for p in sorted(repo.iterdir()):
                print(f"  {p.name}/") if p.is_dir() else print(f"  {p.name}")
            sys.exit(1)
        
        dest_svgs = BIOICONS_DIR / "svgs"
        dest_svgs.mkdir(parents=True, exist_ok=True)
        
        svgs = list(svg_source.rglob("*.svg"))
        copied = 0
        for f in svgs:
            rel = f.relative_to(svg_source)
            dest = dest_svgs / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            if not dest.exists():
                shutil.copy2(f, dest)
                copied += 1
        
        print(f"✓ Copied {copied} new SVGs to {dest_svgs}")
        print(f"  Total SVGs: {len(list(dest_svgs.rglob('*.svg')))}")

if __name__ == "__main__":
    main()
