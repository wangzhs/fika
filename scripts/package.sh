#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

TARGET="${1:-mac}"

case "$TARGET" in
  mac)
    echo "Building macOS bundles (.app + .dmg)..."
    npm run bundle:mac
    ;;
  windows)
    echo "Building Windows bundles (.exe/.msi)..."
    echo "This should normally be run on Windows, or in Windows CI."
    npm run bundle:windows
    ;;
  all)
    echo "Building all bundles for the current host..."
    npm run bundle
    ;;
  *)
    echo "Usage: ./scripts/package.sh [mac|windows|all]"
    exit 1
    ;;
esac

