#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -d node_modules ]; then
  npm install
fi
if [ ! -f .env ]; then
  cp .env.example .env
fi
echo "UI: http://127.0.0.1:5173"
echo "Set VITE_GOOGLE_MAPS_API_KEY in .env then restart if needed."
exec npm run dev
