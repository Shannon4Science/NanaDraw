#!/usr/bin/env python3
"""NanaDraw - One-click startup script."""

import subprocess
import sys
import os
import locale
import webbrowser
import time
import signal
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BACKEND = ROOT / "backend"
FRONTEND = ROOT / "frontend"
FRONTEND_DIST = FRONTEND / "dist"

def is_chinese():
    """Detect if system locale is Chinese."""
    for var in ("LC_ALL", "LC_MESSAGES", "LANG", "LANGUAGE"):
        val = os.environ.get(var, "")
        if val:
            return val.lower().startswith("zh")
    try:
        lang = locale.getlocale()[0] or ""
    except (ValueError, TypeError):
        return False
    return lang.startswith("zh") or lang.startswith("Chinese")

def t(zh: str, en: str) -> str:
    return zh if is_chinese() else en

def check_python():
    v = sys.version_info
    if v < (3, 10):
        print(t(f"❌ 需要 Python >= 3.10，当前 {v.major}.{v.minor}",
                f"❌ Python >= 3.10 required, got {v.major}.{v.minor}"))
        sys.exit(1)
    print(t(f"✓ Python {v.major}.{v.minor}.{v.micro}", f"✓ Python {v.major}.{v.minor}.{v.micro}"))

def check_node():
    try:
        result = subprocess.run(["node", "--version"], capture_output=True, text=True)
        version = result.stdout.strip().lstrip("v")
        major = int(version.split(".")[0])
        if major < 18:
            print(t(f"❌ 需要 Node.js >= 18，当前 {version}", f"❌ Node.js >= 18 required, got {version}"))
            sys.exit(1)
        print(t(f"✓ Node.js {version}", f"✓ Node.js {version}"))
    except FileNotFoundError:
        print(t("❌ 未找到 Node.js，请先安装", "❌ Node.js not found, please install it"))
        sys.exit(1)

def check_pnpm():
    try:
        result = subprocess.run(["pnpm", "--version"], capture_output=True, text=True)
        print(t(f"✓ pnpm {result.stdout.strip()}", f"✓ pnpm {result.stdout.strip()}"))
    except FileNotFoundError:
        print(t("❌ 未找到 pnpm，请运行: npm install -g pnpm", "❌ pnpm not found, run: npm install -g pnpm"))
        sys.exit(1)

def _backend_deps_installed() -> bool:
    """Quick check: import a few key backend packages to see if deps are present."""
    try:
        import importlib
        for mod in ("fastapi", "uvicorn", "httpx", "PIL"):
            importlib.import_module(mod)
        return True
    except ImportError:
        return False


def install_deps():
    if _backend_deps_installed():
        print(t("\n✓ 后端依赖已安装", "\n✓ Backend dependencies already installed"))
    else:
        print(t("\n📦 安装后端依赖...", "\n📦 Installing backend dependencies..."))
        subprocess.run([sys.executable, "-m", "pip", "install", "-r", str(BACKEND / "requirements.txt"), "-q"],
                       check=True)

    node_modules = FRONTEND / "node_modules"
    if node_modules.exists() and (node_modules / ".pnpm").exists():
        print(t("✓ 前端依赖已安装", "✓ Frontend dependencies already installed"))
    else:
        print(t("📦 安装前端依赖...", "📦 Installing frontend dependencies..."))
        subprocess.run(["pnpm", "install", "--frozen-lockfile"], cwd=str(FRONTEND), check=True)

def prompt_download(name_zh: str, name_en: str, script: str) -> bool:
    name = t(name_zh, name_en)
    print(t(f"\n📥 {name} 数据未下载", f"\n📥 {name} data not downloaded"))
    print(t("  [1] 立即下载（推荐）", "  [1] Download now (recommended)"))
    print(t("  [2] 跳过", "  [2] Skip for now"))
    choice = input(t("请选择 [1/2]: ", "Choose [1/2]: ")).strip()
    if choice == "1":
        subprocess.run([sys.executable, str(ROOT / "scripts" / script)], check=True)
        return True
    return False

def prompt_rembg():
    print(t("\n📥 rembg 背景移除模型（~170MB）未下载",
            "\n📥 rembg background removal model (~170MB) not downloaded"))
    print(t("  [1] 立即下载（推荐）", "  [1] Download now (recommended)"))
    print(t("  [2] 跳过（首次生成时自动下载）", "  [2] Skip (auto-downloads on first use)"))
    choice = input(t("请选择 [1/2]: ", "Choose [1/2]: ")).strip()
    if choice == "1":
        print(t("正在下载 rembg 模型...", "Downloading rembg model..."))
        subprocess.run([sys.executable, "-c",
                        "from rembg import new_session; new_session('u2net')"],
                       check=True)
        print(t("✓ rembg 模型下载完成", "✓ rembg model downloaded"))

def check_data():
    gallery_dir = BACKEND / "static" / "gallery"
    gallery_images = [f for f in gallery_dir.iterdir()
                      if f.suffix.lower() in (".png", ".jpg", ".jpeg", ".webp")] if gallery_dir.exists() else []
    if len(gallery_images) < 10:
        prompt_download("Gallery 参考图", "Gallery reference images", "download_gallery.py")
    else:
        print(t(f"✓ Gallery 参考图已就绪 ({len(gallery_images)} 张)",
                f"✓ Gallery reference images ready ({len(gallery_images)} images)"))

    bioicons_svgs = BACKEND / "static" / "bioicons" / "svgs"
    svg_count = len(list(bioicons_svgs.glob("**/*.svg"))) if bioicons_svgs.exists() else 0
    if svg_count < 10:
        prompt_download("Bioicons SVG 图标", "Bioicons SVG icons", "download_bioicons.py")
    else:
        print(t(f"✓ Bioicons SVG 图标已就绪 ({svg_count} 个)",
                f"✓ Bioicons SVG icons ready ({svg_count} icons)"))

    rembg_home = Path.home() / ".u2net" / "u2net.onnx"
    if not rembg_home.exists():
        prompt_rembg()
    else:
        print(t("✓ rembg 背景移除模型已就绪", "✓ rembg background removal model ready"))

def build_frontend():
    if FRONTEND_DIST.exists() and (FRONTEND_DIST / "index.html").exists():
        print(t("✓ 前端已构建", "✓ Frontend already built"))
        return
    print(t("\n🔨 构建前端...", "\n🔨 Building frontend..."))
    subprocess.run(["bash", str(FRONTEND / "scripts" / "build.sh")], check=True)
    print(t("✓ 前端构建完成", "✓ Frontend build complete"))

def start_server(port: int = 8001):
    print(t(f"\n🚀 启动 NanaDraw 服务器 (端口 {port})...",
            f"\n🚀 Starting NanaDraw server (port {port})..."))
    print(t(f"   打开浏览器访问 http://localhost:{port}",
            f"   Open browser at http://localhost:{port}"))
    
    # Open browser after a short delay
    def open_browser():
        time.sleep(2)
        webbrowser.open(f"http://localhost:{port}")
    
    import threading
    threading.Thread(target=open_browser, daemon=True).start()
    
    os.chdir(str(BACKEND))
    subprocess.run([
        sys.executable, "-m", "uvicorn", "app.main:app",
        "--host", "0.0.0.0", "--port", str(port),
    ])

def start_dev(port: int = 8001):
    """Start both Vite dev server and uvicorn for development."""
    print(t("\n🔧 开发模式启动...", "\n🔧 Starting in dev mode..."))
    
    # Start backend
    backend_proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app.main:app",
         "--host", "0.0.0.0", "--port", str(port), "--reload"],
        cwd=str(BACKEND)
    )
    
    # Start frontend vite dev server
    frontend_proc = subprocess.Popen(
        ["pnpm", "dev"],
        cwd=str(FRONTEND)
    )
    
    def cleanup(sig=None, frame=None):
        frontend_proc.terminate()
        backend_proc.terminate()
        sys.exit(0)
    
    signal.signal(signal.SIGINT, cleanup)
    signal.signal(signal.SIGTERM, cleanup)
    
    print(t(f"\n✓ 后端: http://localhost:{port}",
            f"\n✓ Backend: http://localhost:{port}"))
    print(t("✓ 前端: http://localhost:3001",
            "✓ Frontend: http://localhost:3001"))
    
    try:
        backend_proc.wait()
    except KeyboardInterrupt:
        cleanup()

def main():
    import argparse
    parser = argparse.ArgumentParser(description="NanaDraw Startup Script")
    parser.add_argument("--dev", action="store_true", help="Development mode")
    parser.add_argument("--port", type=int, default=8001, help="Server port")
    parser.add_argument("--build", action="store_true", help="Force rebuild frontend")
    parser.add_argument("--skip-deps", action="store_true", help="Skip dependency install")
    parser.add_argument("--skip-download", action="store_true",
                        help="Skip interactive data download prompts (gallery, bioicons, rembg)")
    args = parser.parse_args()

    print(t("🎨 NanaDraw — 学术论文 Pipeline 图生成工具",
            "🎨 NanaDraw — Academic Paper Pipeline Diagram Generator"))
    print("=" * 50)

    check_python()
    check_node()
    check_pnpm()

    if not args.skip_deps:
        install_deps()
    
    if not args.skip_download:
        check_data()
    else:
        print(t("⏭ 跳过数据下载（使用 --skip-download）",
                "⏭ Skipping data download (--skip-download)"))

    if args.build:
        # Force rebuild
        import shutil
        if FRONTEND_DIST.exists():
            shutil.rmtree(FRONTEND_DIST)
    
    if args.dev:
        start_dev(args.port)
    else:
        build_frontend()
        start_server(args.port)

if __name__ == "__main__":
    main()
