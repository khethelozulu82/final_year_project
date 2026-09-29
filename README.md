# THEMBA — Final runnable system

Transport Hub with Evaluated Mobility, Boarding & Accountability.

```
Final_Year_Project-integrated-system/
  backend/     Django API (accounts + transport) — SQLite or PostgreSQL
  frontend/    React + Google Maps UI
```

## Backend

```bash
cd backend
# Recommended for final test / hosting:
#   docker compose up -d db
#   copy .env.example → .env and set:
#     DATABASE_URL=postgres://themba:themba@127.0.0.1:5432/themba
#     ORS_API_KEY=<your openrouteservice key>
./run_host.sh
# or:
#   python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
#   pip install -r requirements.txt
#   python manage.py migrate
#   python manage.py seed_themba          # demo accounts only
#   daphne -b 0.0.0.0 -p 8000 themba_project.asgi:application
```

## Frontend

```bash
cd frontend
# edit .env → set VITE_GOOGLE_MAPS_API_KEY=
./run_frontend.sh
# or: npm install && npm run dev
```

Open http://127.0.0.1:5173

Demo password: **themba123**  
Accounts: `passenger_demo` | `driver_demo` | `operator_demo` | `admin_demo`

## API keys (required for full routing)

| Key | File | Notes |
|-----|------|--------|
| `ORS_API_KEY` | `backend/.env` | OpenRouteService — road geometry (no straight-line fallback) |
| `VITE_GOOGLE_MAPS_API_KEY` | `frontend/.env` | Google Maps display |

## Routing policy

- Directions use **OpenRouteService first** when `ORS_API_KEY` is set.
- Falls back to OSRM (`ROUTING_SERVICE_URL`) only if ORS fails.
- **No straight-line geometry** is returned by the API when both fail (error is raised).

## Roles

| Role | Dashboard | Sign out |
|------|-----------|----------|
| Passenger | Map, search, verify code, My bookings, panic, feedback | Header exit |
| Driver | Assigned trips, live GPS, ride requests | Top bar |
| Operator | Rank-scoped queue, boardings, announcements | Nav footer |
| Admin | Overview, trips, accounts, safety, history | Nav footer |

## PostgreSQL (final test)

```bash
cd backend
docker compose up -d db
# .env: DATABASE_URL=postgres://themba:themba@127.0.0.1:5432/themba
python manage.py migrate
python manage.py seed_themba
```

Seed leaves only demo accounts and core ranks/routes needed for testing.
