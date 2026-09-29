#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -d .venv ]; then
  python3 -m venv .venv
fi
# shellcheck disable=SC1091
source .venv/bin/activate
pip install -q -r requirements.txt
if [ ! -f .env ]; then
  cp .env.example .env
fi
python manage.py makemigrations accounts transport
python manage.py migrate
python manage.py seed_themba
echo ""
echo "API: http://127.0.0.1:8000  (LAN: http://$(hostname -I 2>/dev/null | awk '{print $1}'):8000 )"
echo "Health: http://127.0.0.1:8000/api/health/"
exec daphne -b 0.0.0.0 -p 8000 themba_project.asgi:application
