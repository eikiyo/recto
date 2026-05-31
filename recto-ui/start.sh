#!/usr/bin/env bash
# recto — local static server on :8765
set -euo pipefail
cd "$(dirname "$0")"
PORT="${PORT:-8765}"
echo "recto · http://localhost:${PORT}"
echo "screens: http://localhost:${PORT}/screens.html"
exec python3 -m http.server "${PORT}"
