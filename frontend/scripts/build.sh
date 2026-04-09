#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FRONTEND_DIR="$(dirname "$SCRIPT_DIR")"
ROOT_DIR="$(dirname "$FRONTEND_DIR")"

echo "=== Building React frontend ==="
cd "$FRONTEND_DIR"
npx tsc -b && npx vite build

echo "=== Copying draw.io webapp ==="
rm -rf "$FRONTEND_DIR/dist/drawio"
cp -r "$ROOT_DIR/drawio/src/main/webapp" "$FRONTEND_DIR/dist/drawio"

echo "=== Build complete ==="
echo "Output: $FRONTEND_DIR/dist/"
