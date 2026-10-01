/**
 * Driver console — 3 stages:
 *   Stage 1: Ready for dispatch (verification, trip code, My trips, notifications)
 *   Stage 2: Selected trip map panel (route polyline, trip info, dot bar)
 *   Stage 3: Selected route point (sidebar list + floating point card)
 *
 * Two top-level views:
 *   - Dispatch (the original stage flow)
 *   - History  (the driver's own audited actions)
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, getUser } from '../api';
import { computeRoute } from '../services/routingApi';
import ThembaMap from '../components/ThembaMap';
import ThemeToggle from '../components/ThemeToggle.jsx';
import '../styles/driverConsole.css';

function fmtTime(t) {
  if (!t) return '—';
  const s = String(t);
  return s.length >= 5 ? s.slice(0, 5) : s;
}

function statusLabel(s) {
  return String(s || 'scheduled').replace(/_/g, ' ').toUpperCase();
}

function buildRoutePoints(trip) {
  const route = trip?.route;
  if (!route) return [];

  const stops = Array.isArray(route.stops) ? [...route.stops] : [];
  if (stops.length >= 2) {
    return stops
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .map((s, i) => ({
        id: s.id ?? i,
        order: i + 1,
        name: s.name || `Stop ${i + 1}`,
        lat: Number(s.lat ?? s.latitude),
        lng: Number(s.lng ?? s.longitude),
        scheduled: s.scheduled_time || s.eta || null,
        note: s.note || s.operational_note || '',
      }))
      .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  }

  const pts = [];
  const dep = route.departure;
  const dest = route.destination;

  if (dep?.latitude != null) {
    pts.push({
      id: 'dep',
      order: 1,
      name: `${dep.name || 'Departure'} depot`,
      lat: Number(dep.latitude),
      lng: Number(dep.longitude),
      scheduled: trip.expected_departure_time,
      note: 'Boarding / departure rank',
    });
  }

  const geom = Array.isArray(route.geometry) ? route.geometry : [];
  if (geom.length > 4) {
    const midIdx = [
      Math.floor(geom.length * 0.33),
      Math.floor(geom.length * 0.66),
    ];
    midIdx.forEach((idx, n) => {
      const g = geom[idx];
      if (!Array.isArray(g) || g.length < 2) return;
      pts.push({
        id: `mid-${n}`,
        order: pts.length + 1,
        name: n === 0 ? 'Mid corridor' : 'Approach',
        lat: Number(g[0]),
        lng: Number(g[1]),
        scheduled: null,
        note: 'Tap for corridor checkpoint',
      });
    });
  }

  if (dest?.latitude != null) {
    pts.push({
      id: 'dest',
      order: pts.length + 1,
      name: `${dest.name || 'Destination'} terminus`,
      lat: Number(dest.latitude),
      lng: Number(dest.longitude),
      scheduled: null,
      note: 'Final drop-off',
    });
  }

  return pts;
}

export default function DriverPage({ notify, onExit }) {
  const user = getUser();
  const driverName =
    [user?.first_name, user?.last_name].filter(Boolean).join(' ') ||
    user?.username ||
    'Driver';

  const [vehicle, setVehicle] = useState(null);
  const [profile, setProfile] = useState(null);
  const [trips, setTrips] = useState([]);
  const [tripCodeInput, setTripCodeInput] = useState('');
  const [matchedCode, setMatchedCode] = useState('');
  const [confirming, setConfirming] = useState(false);

  const [selectedTrip, setSelectedTrip] = useState(null);
  const [rideRequestPanel, setRideRequestPanel] = useState(null);
  const [rideRequestBusy, setRideRequestBusy] = useState(false);
  const [selectedPoint, setSelectedPoint] = useState(null);
  const [tracking, setTracking] = useState(false);
  const [lastGps, setLastGps] = useState(null);
  const [passengerPickup, setPassengerPickup] = useState(null);

  const [liveStatus, setLiveStatus] = useState(null);
  const [statusUpdatedAt, setStatusUpdatedAt] = useState(null);

  const [driverRouteGeometry, setDriverRouteGeometry] = useState([]);
  const autoStartedForTripRef = useRef(null);

  const watchRef = useRef(null);
  const timerRef = useRef(null);
  const latestPos = useRef(null);
  const selectedTripRef = useRef(null);
  selectedTripRef.current = selectedTrip;

  // Top-level view + history
  const [view, setView] = useState('dispatch'); // 'dispatch' | 'history'
  const [historyRows, setHistoryRows] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  async function refreshTrips() {
    try {
      const rows = await api.driverTrips();
      setTrips(Array.isArray(rows) ? rows : []);
      return rows;
    } catch {
      setTrips([]);
      return [];
    }
  }

  async function refreshProfile() {
    try {
      const p = await api.driverProfile();
      setProfile(p);
      return p;
    } catch {
      return null;
    }
  }

  useEffect(() => {
    api.myVehicle().then(setVehicle).catch((e) => notify?.(e.message));
    refreshProfile();
    refreshTrips();
    const id = setInterval(refreshProfile, 45000);
    return () => {
      clearInterval(id);
      stopTracking();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load history when the tab is opened
  useEffect(() => {
    if (view !== 'history') return undefined;
    setHistoryLoading(true);
    api
      .history()
      .then((rows) => setHistoryRows(Array.isArray(rows) ? rows : []))
      .catch(() => setHistoryRows([]))
      .finally(() => setHistoryLoading(false));
    return undefined;
  }, [view]);

  useEffect(() => {
    if (!selectedTrip) return undefined;

    const shouldAutoStart = (t) => {
      if (!t) return false;
      if (t.status === 'in_progress') return true;
      const cap = Number(t.seat_capacity) || 0;
      const taken = Number(t.seats_taken) || 0;
      if (cap > 0 && taken >= cap) return true;
      if (t.status === 'boarding' && taken > 0) return true;
      return false;
    };

    if (shouldAutoStart(selectedTrip) && !tracking) {
      if (autoStartedForTripRef.current !== selectedTrip.id) {
        autoStartedForTripRef.current = selectedTrip.id;
        setTimeout(() => {
          try {
            startTracking();
            notify?.('Live GPS started automatically — trip is boarding.');
          } catch (e) {
            notify?.(e.message);
          }
        }, 800);
      }
    }

    const pollId = setInterval(async () => {
      try {
        const fresh = await api.tripDetail(selectedTrip.id);
        setSelectedTrip((prev) =>
          prev && prev.id === fresh.id ? { ...prev, ...fresh } : prev
        );
        setTrips((prev) =>
          prev.map((row) => (row.id === fresh.id ? { ...row, ...fresh } : row))
        );

        if (
          shouldAutoStart(fresh) &&
          !tracking &&
          autoStartedForTripRef.current !== fresh.id
        ) {
          autoStartedForTripRef.current = fresh.id;
          startTracking();
          notify?.('Live GPS started automatically — trip is boarding.');
        }
      } catch {
        /* ignore poll errors */
      }
    }, 12000);

    return () => clearInterval(pollId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTrip?.id, tracking]);

  useEffect(() => {
    if (!selectedTrip) {
      setLiveStatus(null);
      setStatusUpdatedAt(null);
      return undefined;
    }

    let cancelled = false;
    const tripId = selectedTrip.id;

    const tick = async () => {
      try {
        const data = await api.tripDetail(tripId);
        if (cancelled) return;
        if (data?.status) {
          setLiveStatus(data.status);
          setStatusUpdatedAt(new Date());
          setSelectedTrip((prev) =>
            prev && prev.id === tripId ? { ...prev, ...data } : prev
          );
          setTrips((prev) =>
            prev.map((row) => (row.id === tripId ? { ...row, ...data } : row))
          );
        }
      } catch {
        /* silent */
      }
    };

    tick();
    const id = setInterval(tick, 6000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [selectedTrip?.id]);

  useEffect(() => {
    if (!selectedTrip) {
      setDriverRouteGeometry([]);
      return undefined;
    }

    let cancelled = false;

    async function fetchRoute() {
      const route = selectedTrip.route;
      if (!route) return;

      const geom = Array.isArray(route.geometry) ? route.geometry : [];
      if (geom.length >= 3) {
        if (!cancelled) setDriverRouteGeometry(geom);
        return;
      }

      const dep = route.departure;
      const dest = route.destination;
      if (
        !dep ||
        !dest ||
        dep.latitude == null ||
        dep.longitude == null ||
        dest.latitude == null ||
        dest.longitude == null
      ) {
        if (!cancelled) setDriverRouteGeometry([]);
        return;
      }

      try {
        const leg = await computeRoute(
          { lat: Number(dep.latitude), lng: Number(dep.longitude) },
          { lat: Number(dest.latitude), lng: Number(dest.longitude) }
        );
        if (cancelled) return;
        const g = Array.isArray(leg.geometry) ? leg.geometry : [];
        setDriverRouteGeometry(g.length >= 3 ? g : []);
      } catch (err) {
        console.debug('[driver-route] computeRoute failed:', err.message);
        if (!cancelled) setDriverRouteGeometry([]);
      }
    }

    fetchRoute();

    return () => {
      cancelled = true;
    };
  }, [selectedTrip?.id]);

  useEffect(() => {
    if (!selectedTrip) return undefined;
    if (typeof navigator === 'undefined' || !navigator.geolocation) return undefined;

    let cancelled = false;

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (cancelled) return;
        setLastGps({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          at: new Date().toISOString(),
          route_status: null,
        });
      },
      () => {
        /* silently ignore */
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 5000 }
    );

    return () => {
      cancelled = true;
    };
  }, [selectedTrip?.id]);

  async function markNotificationRead(id) {
    try {
      await api.notificationsMarkRead(id);
      setProfile((prev) =>
        prev
          ? {
              ...prev,
              notifications: (prev.notifications || []).map((n) =>
                n.id === id ? { ...n, read: true } : n
              ),
            }
          : prev
      );
    } catch (e) {
      notify?.(e.message);
    }
  }

  async function openRideRequestFromNotification(n) {
    const meta = n.meta || {};
    if (meta.expired || meta.rejected_by_me) {
      notify?.('This request is no longer available.');
      return;
    }
    const requestId = meta.request_id;
    if (!requestId) {
      notify?.('No ride request id on this notification.');
      return;
    }
    try {
      if (n.id) await api.notificationsMarkRead(n.id);
    } catch {
      /* ignore */
    }
    let detail = null;
    try {
      detail = await api.getRideRequest(requestId);
    } catch {
      detail = null;
    }
    setRideRequestPanel({
      requestId,
      notificationId: n.id,
      passenger_name:
        detail?.passenger_name || meta.passenger_name || 'Passenger',
      passenger_lat: detail?.passenger_lat ?? meta.passenger_lat,
      passenger_lng: detail?.passenger_lng ?? meta.passenger_lng,
      trip_code: detail?.trip_code || meta.trip_code,
      status: detail?.status || 'pending',
    });
  }

  async function acceptRideRequest() {
    if (!rideRequestPanel?.requestId) return;
    setRideRequestBusy(true);
    try {
      await api.acceptRideRequest(rideRequestPanel.requestId);
      notify?.('Trip accepted — passenger will see Driver incoming.');
      setRideRequestPanel(null);
      try {
        const prof = await api.driverProfile();
        setProfile(prof);
      } catch {
        /* ignore */
      }
    } catch (e) {
      notify?.(e.message || 'Could not accept (maybe another driver took it).');
      setRideRequestPanel(null);
    } finally {
      setRideRequestBusy(false);
    }
  }

  async function rejectRideRequest() {
    if (!rideRequestPanel?.requestId) return;
    setRideRequestBusy(true);
    try {
      await api.rejectRideRequest(rideRequestPanel.requestId);
      notify?.('Request rejected.');
    } catch (e) {
      notify?.(e.message || 'Could not reject.');
    } finally {
      setRideRequestBusy(false);
      setRideRequestPanel(null);
    }
  }

  async function markAllNotificationsRead() {
    const unread = (profile?.notifications || []).filter((n) => !n.read);
    if (!unread.length) return;
    try {
      await Promise.all(unread.map((n) => api.notificationsMarkRead(n.id)));
      setProfile((prev) =>
        prev
          ? {
              ...prev,
              notifications: (prev.notifications || []).map((n) => ({
                ...n,
                read: true,
              })),
            }
          : prev
      );
      notify?.('All notifications marked as read.');
    } catch (e) {
      notify?.(e.message);
    }
  }

  function stopTracking() {
    if (watchRef.current != null && navigator.geolocation) {
      navigator.geolocation.clearWatch(watchRef.current);
      watchRef.current = null;
    }
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setTracking(false);
  }

  async function pushOnce(coords) {
    if (!vehicle?.id) return;
    try {
      const payload = {
        lat: coords.latitude,
        lng: coords.longitude,
        speed_kmh: coords.speed != null ? coords.speed * 3.6 : null,
        heading_deg: coords.heading || 0,
        accuracy_m: coords.accuracy || 0,
        source: 'gps',
        trip_id: selectedTripRef.current?.id,
      };
      const res = await api.postLocation(vehicle.id, payload);
      setLastGps({
        lat: coords.latitude,
        lng: coords.longitude,
        at: new Date().toISOString(),
        route_status: res?.route_status,
      });
    } catch (e) {
      console.debug('[gps] push failed:', e.message);
    }
  }

  function startTracking() {
    if (!vehicle) {
      notify?.('No vehicle assigned. Link a vehicle first.');
      return;
    }
    if (!navigator.geolocation) {
      notify?.('Geolocation not available on this device.');
      return;
    }
    stopTracking();
    setTracking(true);
    watchRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        latestPos.current = pos.coords;
      },
      (err) => notify?.(err.message),
      { enableHighAccuracy: true, maximumAge: 3000, timeout: 15000 }
    );
    timerRef.current = setInterval(() => {
      if (latestPos.current) pushOnce(latestPos.current);
    }, 5000);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        latestPos.current = pos.coords;
        pushOnce(pos.coords);
      },
      () => {},
      { enableHighAccuracy: true }
    );
  }

  async function handleConfirmTrip() {
    const code = tripCodeInput.trim();
    if (!code) {
      notify?.('Enter the trip code from the operator / manifest.');
      return;
    }
    setConfirming(true);
    try {
      const trip = await api.confirmTrip(code);
      setMatchedCode(trip.trip_code || code.toUpperCase());
      await refreshTrips();
      notify?.(
        `Trip ${trip.trip_code} matched — select it from My trips to open the map.`
      );
      setTripCodeInput('');
    } catch (e) {
      notify?.(e.message || 'Could not confirm trip code.');
    } finally {
      setConfirming(false);
    }
  }

  function openTrip(trip, pickup = null) {
    setSelectedTrip(trip);
    setSelectedPoint(null);
    setPassengerPickup(pickup);
  }

  function selectPoint(point) {
    setSelectedPoint(point);
  }

  function backToTripInfo() {
    setSelectedPoint(null);
  }

  function backToList() {
    setSelectedTrip(null);
    setSelectedPoint(null);
    setPassengerPickup(null);
    autoStartedForTripRef.current = null;
  }

  async function openNotification(n) {
    const meta = n.meta || {};
    if (meta.type === 'ride_request' || meta.request_id) {
      await openRideRequestFromNotification(n);
      return;
    }
    const tripId = n.trip_id || meta.trip_id;
    try {
      if (n.id && !n.read) {
        await api.notificationsMarkRead(n.id);
        setProfile((prev) =>
          prev
            ? {
                ...prev,
                notifications: (prev.notifications || []).map((x) =>
                  x.id === n.id ? { ...x, read: true } : x
                ),
              }
            : prev
        );
      }
    } catch {
      /* ignore */
    }
    let trip =
      (trips || []).find((x) => x.id === tripId) ||
      (profile?.trips || []).find((x) => x.id === tripId);
    if (!trip && tripId) {
      const rows = await refreshTrips();
      trip = (rows || []).find((x) => x.id === tripId);
    }
    if (trip) {
      openTrip(trip, null);
      notify?.(`Opened ${trip.trip_code} from notification.`);
    } else {
      notify?.(
        n.body ||
          'Notification opened. Confirm the trip code if this trip is not yet in My trips.'
      );
      if (meta.trip_code) setTripCodeInput(String(meta.trip_code));
    }
  }

  const routePoints = useMemo(
    () => (selectedTrip ? buildRoutePoints(selectedTrip) : []),
    [selectedTrip]
  );

  const mapOverlays = useMemo(() => {
    if (!selectedTrip) return { polylines: [], markers: [] };
    const route = selectedTrip.route || {};
    const backendGeom = Array.isArray(route.geometry) ? route.geometry : [];
    const lines = [];

    const routeGeom =
      driverRouteGeometry.length >= 3
        ? driverRouteGeometry
        : backendGeom.length >= 3
          ? backendGeom
          : [];

    if (routeGeom.length >= 3) {
      lines.push({
        id: 'driver-route',
        positions: routeGeom,
        color: '#e6a841',
        weight: 5,
      });
    } else if (routePoints.length >= 3) {
      lines.push({
        id: 'driver-route-stops',
        positions: routePoints.map((p) => [p.lat, p.lng]),
        color: '#e6a841',
        weight: 5,
        dashed: true,
      });
    }

    const markers = routePoints.map((p) => ({
      id: `rp-${p.id}`,
      lat: p.lat,
      lng: p.lng,
      label: `${String(p.order).padStart(2, '0')} · ${p.name}`,
      kind: 'rank',
      color: selectedPoint?.id === p.id ? '#f5a524' : '#0f766e',
    }));

    if (lastGps?.lat != null && lastGps?.lng != null) {
      markers.push({
        id: 'driver-live',
        lat: lastGps.lat,
        lng: lastGps.lng,
        label: 'You (live GPS)',
        kind: 'vehicle',
        color: '#22c55e',
      });
    } else if (tracking && latestPos.current) {
      markers.push({
        id: 'driver-live',
        lat: latestPos.current.latitude,
        lng: latestPos.current.longitude,
        label: 'You (starting…)',
        kind: 'vehicle',
        color: '#22c55e',
      });
    }

    if (passengerPickup?.lat != null && passengerPickup?.lng != null) {
      markers.push({
        id: 'passenger-pickup',
        lat: passengerPickup.lat,
        lng: passengerPickup.lng,
        label: `${passengerPickup.name || 'Passenger'} (pickup)`,
        kind: 'user',
        color: '#38bdf8',
      });
    }

    return { polylines: lines, markers };
  }, [
    selectedTrip,
    routePoints,
    selectedPoint,
    lastGps,
    driverRouteGeometry,
    tracking,
    passengerPickup,
  ]);

  const progressPct = useMemo(() => {
    if (!routePoints.length || !selectedPoint) {
      if (selectedTrip?.status === 'in_progress') return 38;
      if (selectedTrip?.status === 'boarding') return 12;
      if (selectedTrip?.status === 'completed') return 100;
      return 0;
    }
    return Math.round((selectedPoint.order / routePoints.length) * 100);
  }, [routePoints, selectedPoint, selectedTrip]);

  const unreadCount = (profile?.notifications || []).filter((n) => !n.read).length;

  if (rideRequestPanel) {
    const lat = Number(rideRequestPanel.passenger_lat);
    const lng = Number(rideRequestPanel.passenger_lng);
    const hasLoc = Number.isFinite(lat) && Number.isFinite(lng);
    const markers = hasLoc
      ? [
          {
            id: 'passenger',
            lat,
            lng,
            label: `${rideRequestPanel.passenger_name || 'Passenger'} (live GPS)`,
            kind: 'user',
          },
        ]
      : [];
    return (
      <div className="drv-shell drv-trip-request">
        <div className="drv-request-layout">
          <aside className="drv-request-side">
            <p className="drv-request-kicker">Trip request</p>
            <div className="drv-request-brand">
              <span className="drv-brand-dot" />
            </div>
            <h1 className="drv-request-name">
              {(rideRequestPanel.passenger_name || 'Passenger').split(' ')[0]}
              <br />
              <span>
                {(rideRequestPanel.passenger_name || '')
                  .split(' ')
                  .slice(1)
                  .join(' ') || ''}
              </span>
            </h1>
            <p className="drv-muted">
              Map shows passenger <strong>live GPS</strong>
              {Number.isFinite(Number(rideRequestPanel.passenger_lat))
                ? ` (${Number(rideRequestPanel.passenger_lat).toFixed(
                    5
                  )}, ${Number(rideRequestPanel.passenger_lng).toFixed(5)})`
                : ''}
            </p>
            {rideRequestPanel.trip_code && (
              <p className="drv-muted">Trip context: {rideRequestPanel.trip_code}</p>
            )}
            <div className="drv-request-actions">
              <button
                type="button"
                className="drv-btn primary drv-accept"
                disabled={rideRequestBusy}
                onClick={acceptRideRequest}
              >
                {rideRequestBusy ? '…' : 'ACCEPT TRIP'}
              </button>
              <button
                type="button"
                className="drv-btn ghost drv-reject"
                disabled={rideRequestBusy}
                onClick={rejectRideRequest}
              >
                REJECT TRIP
              </button>
            </div>
          </aside>
          <div className="drv-request-map">
            <ThembaMap
              markers={markers}
              polylines={[]}
              initialCenter={hasLoc ? [lat, lng] : undefined}
              initialZoom={14}
              fitKey={`rr-${rideRequestPanel.requestId}-${lat}-${lng}`}
              height="100%"
            />
          </div>
        </div>
      </div>
    );
  }

  if (view === 'history') {
    return (
      <div className="drv-shell">
        <header className="drv-topbar">
          <div className="drv-brand">
            <span className="drv-logo">FL</span>
            <div>
              <strong>FIELDLINE</strong>
              <small>DRIVER CONSOLE</small>
            </div>
          </div>
          <div className="drv-tabs" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button
              type="button"
              className="drv-btn ghost"
              style={{ padding: '6px 14px' }}
              onClick={() => setView('dispatch')}
            >
              Dispatch
            </button>
            <button
              type="button"
              className="drv-btn primary"
              style={{ padding: '6px 14px' }}
              onClick={() => setView('history')}
            >
              History
              {unreadCount > 0 && (
                <span
                  style={{
                    marginLeft: 6,
                    background: '#f59e0b',
                    color: '#0b1210',
                    borderRadius: 999,
                    padding: '0 6px',
                    fontSize: 11,
                    fontWeight: 800,
                  }}
                >
                  {unreadCount}
                </span>
              )}
            </button>
          </div>
          <div className="drv-top-meta">
            <ThemeToggle />
            <span className="drv-user-chip">{driverName}</span>
            {typeof onExit === 'function' && (
              <button
                type="button"
                className="drv-btn ghost"
                style={{ marginLeft: 8, padding: '6px 10px', fontSize: 12 }}
                onClick={onExit}
              >
                Sign out
              </button>
            )}
          </div>
        </header>

        <div className="drv-home">
          <div className="drv-home-head">
            <div>
              <p className="drv-kicker">SHIFT LOG</p>
              <h1>My history</h1>
              <p className="drv-muted">
                Actions you have performed in the system — trip confirms, GPS
                starts, ride accepts, and other audited events.
              </p>
            </div>
          </div>

          <section className="drv-card">
            {historyLoading && <p className="drv-muted">Loading…</p>}
            {!historyLoading && historyRows.length === 0 && (
              <p className="drv-muted">No recorded actions yet.</p>
            )}
            <ul className="drv-notif-list">
              {historyRows.map((h) => (
                <li key={h.id}>
                  <small>
                    {h.created_at
                      ? new Date(h.created_at).toLocaleString()
                      : ''}{' '}
                    · {h.action}
                  </small>
                  <p>
                    {h.entity_type} {h.entity_id}
                    {h.detail ? ` — ${h.detail}` : ''}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    );
  }

  if (selectedTrip) {
    const from = selectedTrip.route?.departure?.name || '—';
    const to = selectedTrip.route?.destination?.name || '—';
    const plate =
      selectedTrip.vehicle_plate ||
      selectedTrip.vehicle?.plate_number ||
      vehicle?.plate_number ||
      '—';
    const displayStatus = liveStatus || selectedTrip.status;

    return (
      <div className="drv-shell">
        <header className="drv-topbar">
          <div className="drv-brand">
            <span className="drv-logo">FL</span>
            <div>
              <strong>FIELDLINE</strong>
              <small>LIVE ROUTE</small>
            </div>
          </div>
          <div className="drv-tabs" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button
              type="button"
              className="drv-btn ghost"
              style={{ padding: '6px 14px' }}
              onClick={() => setView('dispatch')}
            >
              Dispatch
            </button>
            <button
              type="button"
              className="drv-btn ghost"
              style={{ padding: '6px 14px' }}
              onClick={() => setView('history')}
            >
              History
              {unreadCount > 0 && (
                <span
                  style={{
                    marginLeft: 6,
                    background: '#f59e0b',
                    color: '#0b1210',
                    borderRadius: 999,
                    padding: '0 6px',
                    fontSize: 11,
                    fontWeight: 800,
                  }}
                >
                  {unreadCount}
                </span>
              )}
            </button>
          </div>
          <div className="drv-top-meta">
            <span className="drv-live-dot" /> SYSTEM LIVE
            <ThemeToggle />
            <span className="drv-user-chip">{driverName}</span>
            {typeof onExit === 'function' && (
              <button
                type="button"
                className="drv-btn ghost"
                style={{ marginLeft: 8, padding: '6px 10px', fontSize: 12 }}
                onClick={onExit}
              >
                Sign out
              </button>
            )}
          </div>
        </header>

        <div className="drv-trip-header">
          <button
            type="button"
            className="drv-back"
            onClick={backToList}
            title="Back to trips"
          >
            ←
          </button>
          <div>
            <h1>
              {from} → {to}
            </h1>
            <small>
              {selectedTrip.trip_code}
              {selectedTrip.departure_date ? ` · ${selectedTrip.departure_date}` : ''}
              {selectedTrip.expected_departure_time
                ? ` · ${fmtTime(selectedTrip.expected_departure_time)}`
                : ''}
              {selectedPoint
                ? ` · ROUTE POINT ${String(selectedPoint.order).padStart(2, '0')}`
                : ''}
            </small>
          </div>
          <span className={`drv-pill status-${displayStatus}`}>
            {statusLabel(displayStatus)}
          </span>
          {statusUpdatedAt && (
            <span
              title={`Last synced ${statusUpdatedAt.toLocaleTimeString()}`}
              style={{
                marginLeft: 8,
                color: '#4ade80',
                fontSize: '0.7rem',
              }}
            >
              ● live
            </span>
          )}
        </div>

        <div className="drv-trip-layout">
          <aside className="drv-side">
            {!selectedPoint ? (
              <>
                <p className="drv-kicker">ACTIVE ASSIGNMENT</p>
                <h2>Trip information</h2>
                {passengerPickup && (
                  <div
                    className="drv-card"
                    style={{
                      marginBottom: 12,
                      padding: 10,
                      background: 'rgba(56,189,248,0.06)',
                      border: '1px solid rgba(56,189,248,0.28)',
                      borderRadius: 10,
                    }}
                  >
                    <small className="drv-kicker" style={{ color: '#38bdf8' }}>
                      PASSENGER PICKUP
                    </small>
                    <p style={{ margin: '6px 0 0' }}>
                      <strong>{passengerPickup.name || 'Passenger'}</strong>
                      <br />
                      <span className="drv-muted">
                        {Number(passengerPickup.lat).toFixed(5)},{' '}
                        {Number(passengerPickup.lng).toFixed(5)}
                      </span>
                    </p>
                  </div>
                )}
                <dl className="drv-dl">
                  <div>
                    <dt>Driver</dt>
                    <dd>
                      {driverName}
                      {user?.phone ? ` · ${user.phone}` : ''}
                    </dd>
                  </div>
                  <div>
                    <dt>Vehicle</dt>
                    <dd>{plate}</dd>
                  </div>
                  <div className="drv-dl-row">
                    <div>
                      <dt>Departure</dt>
                      <dd>{fmtTime(selectedTrip.expected_departure_time)}</dd>
                    </div>
                    <div>
                      <dt>Seats</dt>
                      <dd>
                        {selectedTrip.seats_taken ?? 0}/
                        {selectedTrip.seat_capacity ?? '—'}
                      </dd>
                    </div>
                  </div>
                  <div>
                    <dt>Licence</dt>
                    <dd>{profile?.license_number || '—'}</dd>
                  </div>
                  <div>
                    <dt>Status</dt>
                    <dd>
                      {statusLabel(displayStatus)}
                      {statusUpdatedAt && (
                        <span
                          style={{
                            marginLeft: 8,
                            color: '#4ade80',
                            fontSize: '0.7rem',
                          }}
                        >
                          ● live
                        </span>
                      )}
                    </dd>
                  </div>
                </dl>

                <div className="drv-progress">
                  <div className="drv-progress-head">
                    <span>Route progress</span>
                    <strong>{progressPct}%</strong>
                  </div>
                  <div className="drv-progress-bar">
                    <i style={{ width: `${progressPct}%` }} />
                  </div>
                  <small>Select any amber route dot to inspect stop and timing.</small>
                </div>

                <div className="drv-actions">
                  {!tracking ? (
                    <button
                      type="button"
                      className="drv-btn primary"
                      onClick={() => {
                        startTracking();
                        notify?.('Live GPS sharing started for this shift.');
                      }}
                    >
                      Start live GPS
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="drv-btn danger"
                      onClick={stopTracking}
                    >
                      Stop GPS
                    </button>
                  )}
                  {lastGps && (
                    <small className="drv-gps-hint">
                      Last fix {lastGps.lat.toFixed(5)}, {lastGps.lng.toFixed(5)}
                      {lastGps.route_status ? ` · ${lastGps.route_status}` : ''}
                    </small>
                  )}
                </div>
              </>
            ) : (
              <>
                <p className="drv-kicker">Route points</p>
                <p className="drv-muted">
                  Point {String(selectedPoint.order).padStart(2, '0')} selected. Choose another
                  dot to inspect.
                </p>
                <ul className="drv-point-list">
                  {routePoints.map((p) => (
                    <li key={p.id}>
                      <button
                        type="button"
                        className={
                          selectedPoint.id === p.id ? 'drv-point active' : 'drv-point'
                        }
                        onClick={() => selectPoint(p)}
                      >
                        <span className="drv-point-num">
                          {String(p.order).padStart(2, '0')}
                        </span>
                        <span>
                          <strong>{p.name}</strong>
                          <small>{fmtTime(p.scheduled) || '—'}</small>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
                <button
                  type="button"
                  className="drv-btn ghost"
                  onClick={backToTripInfo}
                >
                  Back to trip info
                </button>
              </>
            )}
          </aside>

          <main className="drv-map-pane">
            <ThembaMap
              polylines={mapOverlays.polylines}
              markers={mapOverlays.markers}
              height="100%"
              fitKey={[
                selectedTrip.id,
                selectedPoint?.id || '',
                lastGps?.at || '',
                lastGps?.lat != null ? lastGps.lat.toFixed(4) : '',
                lastGps?.lng != null ? lastGps.lng.toFixed(4) : '',
                passengerPickup?.lat || '',
                driverRouteGeometry.length,
              ].join('-')}
              onMapClick={() => {}}
              onMarkerClick={(m) => {
                const point = routePoints.find((p) => `rp-${p.id}` === m.id);
                if (point) selectPoint(point);
              }}
            />

            {selectedPoint && (
              <div className="drv-point-card">
                <div className="drv-point-card-head">
                  <span>
                    ROUTE POINT {String(selectedPoint.order).padStart(2, '0')} · SELECTED
                  </span>
                  <button type="button" onClick={backToTripInfo} title="Close">
                    ×
                  </button>
                </div>
                <h3>{selectedPoint.name}</h3>
                <div className="drv-point-grid">
                  <div>
                    <small>Scheduled</small>
                    <strong>{fmtTime(selectedPoint.scheduled) || '—'}</strong>
                  </div>
                  <div>
                    <small>ETA</small>
                    <strong>{fmtTime(selectedPoint.scheduled) || '—'}</strong>
                  </div>
                </div>
                <div className="drv-point-meta">
                  <span>TRIP</span>
                  <strong>{selectedTrip.trip_code}</strong>
                </div>
                {selectedPoint.note && (
                  <div className="drv-point-meta">
                    <span>OPERATIONAL NOTE</span>
                    <strong>{selectedPoint.note}</strong>
                  </div>
                )}
                <div className="drv-point-foot">
                  <span>
                    {plate} · {selectedTrip.seat_capacity ?? '—'} seats
                  </span>
                </div>
              </div>
            )}
          </main>
        </div>
      </div>
    );
  }

  /* ================= Stage 1 — Dispatch ================= */
  return (
    <div className="drv-shell">
      <header className="drv-topbar">
        <div className="drv-brand">
          <span className="drv-logo">FL</span>
          <div>
            <strong>FIELDLINE</strong>
            <small>DRIVER CONSOLE</small>
          </div>
        </div>

        <div className="drv-tabs" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            type="button"
            className="drv-btn primary"
            style={{ padding: '6px 14px' }}
            onClick={() => setView('dispatch')}
          >
            Dispatch
          </button>
          <button
            type="button"
            className="drv-btn ghost"
            style={{ padding: '6px 14px' }}
            onClick={() => setView('history')}
          >
            History
            {unreadCount > 0 && (
              <span
                style={{
                  marginLeft: 6,
                  background: '#f59e0b',
                  color: '#0b1210',
                  borderRadius: 999,
                  padding: '0 6px',
                  fontSize: 11,
                  fontWeight: 800,
                }}
              >
                {unreadCount}
              </span>
            )}
          </button>
        </div>

        <div className="drv-top-meta">
          <span className="drv-live-dot" /> SYSTEM LIVE
          <ThemeToggle />
          <span className="drv-user-chip">{driverName}</span>
          {typeof onExit === 'function' && (
            <button
              type="button"
              className="drv-btn ghost"
              style={{ marginLeft: 8, padding: '6px 10px', fontSize: 12 }}
              onClick={onExit}
            >
              Sign out
            </button>
          )}
        </div>
      </header>

      <div className="drv-home">
        <div className="drv-home-head">
          <div>
            <p className="drv-kicker">
              SHIFT CONTROL ·{' '}
              {new Date()
                .toLocaleDateString(undefined, {
                  weekday: 'short',
                  day: 'numeric',
                  month: 'short',
                })
                .toUpperCase()}
            </p>
            <h1>Ready for dispatch</h1>
            <p className="drv-muted">
              Verify your identity and select an assigned trip to open live routing. The
              operator issues your trip verification code at booking time.
            </p>
          </div>
          <span className="drv-badge">{trips.length} TRIPS ASSIGNED</span>
        </div>

        <div className="drv-cards-row">
          <section className="drv-card">
            <div className="drv-card-head">
              <h3>Driver verification</h3>
              <span className="drv-pill ok">VERIFIED</span>
            </div>
            <div className="drv-kv-grid">
              <div>
                <small>DRIVER</small>
                <strong>{driverName}</strong>
              </div>
              <div>
                <small>DRIVER ID</small>
                <strong>{user?.phone || user?.username || '—'}</strong>
              </div>
              <div>
                <small>LICENCE</small>
                <strong>{profile?.license_number || '—'}</strong>
              </div>
            </div>
          </section>

          <section className="drv-card">
            <div className="drv-card-head">
              <h3>Trip code</h3>
              {matchedCode ? (
                <span className="drv-pill ok">MATCHED</span>
              ) : (
                <span className="drv-pill muted">ENTER CODE</span>
              )}
            </div>
            <label className="drv-label">
              Trip verification code
              <input
                value={tripCodeInput}
                onChange={(e) => setTripCodeInput(e.target.value.toUpperCase())}
                placeholder="e.g. TRP-ONG-EMP-01"
                onKeyDown={(e) => e.key === 'Enter' && handleConfirmTrip()}
              />
            </label>
            <button
              type="button"
              className="drv-btn primary"
              onClick={handleConfirmTrip}
              disabled={confirming}
            >
              {confirming ? 'Confirming…' : 'Confirm trip code'}
            </button>
            {matchedCode && (
              <p className="drv-muted" style={{ marginTop: 8 }}>
                Assigned route confirmed for this shift:{' '}
                <strong>{matchedCode}</strong>
              </p>
            )}
          </section>
        </div>

        <div className="drv-split">
          <section className="drv-card drv-trips-card">
            <div className="drv-card-head">
              <h3>My trips</h3>
              <span className="drv-muted">SELECT A ROW TO VIEW ROUTE →</span>
            </div>
            {trips.length === 0 && (
              <p className="drv-muted">
                No trips assigned yet. Enter a trip code above to claim an assigned trip, or
                wait for the operator to assign you.
              </p>
            )}
            <ul className="drv-trip-list">
              {trips.map((t) => {
                const from = t.route?.departure?.name || '—';
                const to = t.route?.destination?.name || '—';
                const plate = t.vehicle_plate || t.vehicle?.plate_number || '—';
                const active = ['boarding', 'in_progress'].includes(t.status);
                return (
                  <li key={t.id}>
                    <button
                      type="button"
                      className={active ? 'drv-trip-row active' : 'drv-trip-row'}
                      onClick={() => openTrip(t)}
                    >
                      <span className="drv-trip-time">
                        {fmtTime(t.expected_departure_time)}
                      </span>
                      <span className="drv-trip-body">
                        <strong>
                          {from} → {to}
                        </strong>
                        <small>
                          {t.trip_code} · {plate} · {t.seats_taken ?? 0}/
                          {t.seat_capacity ?? '—'} seats
                        </small>
                      </span>
                      <span className={`drv-pill status-${t.status}`}>
                        {statusLabel(t.status)}
                      </span>
                      <span className="drv-chevron">→</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>

          <section className="drv-card">
            <div className="drv-card-head">
              <h3>Notifications</h3>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span className="drv-badge soft">{unreadCount}</span>
                {unreadCount > 0 && (
                  <button
                    type="button"
                    className="drv-btn ghost"
                    style={{ padding: '6px 10px', fontSize: '0.75rem' }}
                    onClick={markAllNotificationsRead}
                  >
                    Mark all read
                  </button>
                )}
              </div>
            </div>
            <ul className="drv-notif-list">
              {(profile?.notifications || []).length === 0 && (
                <li className="drv-muted">No notifications yet.</li>
              )}
              {(profile?.notifications || []).slice(0, 8).map((n) => (
                <li
                  key={n.id}
                  className={n.read ? 'drv-notif read' : 'drv-notif unread'}
                  style={{ cursor: 'pointer' }}
                >
                  <button
                    type="button"
                    className="drv-notif-btn"
                    onClick={() => openNotification(n)}
                  >
                    <small>
                      {n.created_at
                        ? new Date(n.created_at).toLocaleTimeString([], {
                            hour: '2-digit',
                            minute: '2-digit',
                          })
                        : ''}{' '}
                      · {n.title}
                      {!n.read && <span className="drv-notif-dot" />}
                    </small>
                    <p>{n.body}</p>
                    {(n.meta?.type === 'ride_request' || n.meta?.request_id) && (
                      <span className="drv-notif-cta">Open request →</span>
                    )}
                    {!(n.meta?.type === 'ride_request' || n.meta?.request_id) &&
                      (n.trip_id || n.meta?.trip_id) && (
                        <span className="drv-notif-cta">Open route →</span>
                      )}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}