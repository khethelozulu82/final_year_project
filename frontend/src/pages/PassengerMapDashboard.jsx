/**
 * Passenger hub UI — 3 stages: Desk → Route → Active.
 *
 * Key behaviors:
 *  - Completed trips auto-move from "My bookings" into "Archived trips".
 *  - Clicking an archived trip opens the Trip-info panel, where the
 *    "Rate driver" and "File complaint" buttons are enabled exactly
 *    once per trip (backend enforces uniqueness).
 *  - Live status pill updates every 6 s while a trip is open.
 *  - Passenger History tab shows audits, complaints, and ratings.
 */
import { useEffect, useMemo, useState } from 'react';
import { api, getUser } from '../api';
import { computeRoute } from '../services/routingApi';
import ThembaMap, {
  overlaysFromTrip,
  polylineFromDirections,
} from '../components/ThembaMap.jsx';
import {
  PREDETERMINED_PLACES,
  lookupLocalFare,
  nearestRank,
} from '../data/localFares';
import { useGeolocation } from '../hooks/useGeolocation';
import '../styles/passengerMapDashboard.css';

const PLACES = PREDETERMINED_PLACES;
const OFFICIAL_PLACE_NAMES = new Set(PLACES.map((p) => p.name.toLowerCase()));

function isOfficialCorridor(origin, destination) {
  const o = String(origin || '').toLowerCase();
  const d = String(destination || '').toLowerCase();
  return OFFICIAL_PLACE_NAMES.has(o) && OFFICIAL_PLACE_NAMES.has(d);
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function placeByName(name) {
  return PLACES.find((p) => p.name === name) || null;
}

function statusLabel(s) {
  if (!s) return 'VERIFIED';
  return String(s).replace(/_/g, ' ').toUpperCase();
}

function statusClass(s) {
  const v = String(s || '').toLowerCase();
  if (v === 'in_progress' || v === 'boarding') return 'ok';
  if (v === 'completed') return 'muted';
  if (v === 'cancelled') return 'bad';
  if (v === 'flagged') return 'bad';
  return '';
}

function mapApiTrip(t) {
  const origin = t.route?.departure?.name || '—';
  const destination = t.route?.destination?.name || '—';
  let fareNum = t.route?.fare != null ? Number(t.route.fare) : null;
  if (fareNum == null && origin && destination) {
    const local = lookupLocalFare(origin, destination);
    if (local != null) fareNum = Number(local);
  }
  return {
    id: t.id,
    trip_code: null,
    origin,
    destination,
    departure: [t.departure_date, t.expected_departure_time || '']
      .filter(Boolean)
      .join(' '),
    status: t.status,
    operator: t.operator_name || t.route?.operator_name || 'Taxi association',
    driver: t.driver_name || 'To be assigned',
    driver_phone: t.driver_phone || '',
    vehicle: t.vehicle_label || t.vehicle_plate || '—',
    registration: t.vehicle_plate || '—',
    fare: fareNum != null ? `R${fareNum}` : '—',
    fareNum,
    seats_available: t.seats_available,
    raw: t,
  };
}

export default function PassengerMapDashboard({ notify, onExit }) {
  const user = getUser();
  const passengerName =
    [user?.first_name, user?.last_name].filter(Boolean).join(' ') ||
    user?.username ||
    'Passenger';

  const geo = useGeolocation();
  const [departure, setDeparture] = useState('Ongoye');
  const [destination, setDestination] = useState('Empangeni');
  const [results, setResults] = useState([]);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(false);
  const [booking, setBooking] = useState(false);
  const [nearestHint, setNearestHint] = useState(null);
  const [panicOpen, setPanicOpen] = useState(false);

  // Feedback / complaint modals
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackText, setFeedbackText] = useState('');
  const [feedbackScore, setFeedbackScore] = useState(5);
  const [feedbackBusy, setFeedbackBusy] = useState(false);

  const [complaintOpen, setComplaintOpen] = useState(false);
  const [complaintText, setComplaintText] = useState('');
  const [complaintCategory, setComplaintCategory] = useState('other');
  const [complaintBusy, setComplaintBusy] = useState(false);

  const [reviewStatus, setReviewStatus] = useState(null);

  const [selectedBookingId, setSelectedBookingId] = useState(null);
  const [booked, setBooked] = useState(null);
  const [myBookings, setMyBookings] = useState([]);
  const [archivedBookings, setArchivedBookings] = useState([]);
  const [showArchive, setShowArchive] = useState(true);
  const [passengerNotes, setPassengerNotes] = useState([]);
  const [globalAnnouncements, setGlobalAnnouncements] = useState([]);
  const [adhocLine, setAdhocLine] = useState(null);
  const [toRankGeometry, setToRankGeometry] = useState([]);
  const [taxiGeometry, setTaxiGeometry] = useState([]);
  const [routing, setRouting] = useState(false);
  const [verifyInput, setVerifyInput] = useState('');
  const [verifiedTrip, setVerifiedTrip] = useState(null);
  const [liveTrip, setLiveTrip] = useState(null);
  const [liveError, setLiveError] = useState('');
  const [liveStatus, setLiveStatus] = useState(null);
  const [statusUpdatedAt, setStatusUpdatedAt] = useState(null);
  const [viewMode, setViewMode] = useState('desk');

  // Desk vs History tab
  const [deskTab, setDeskTab] = useState('desk'); // desk | history
  const [history, setHistory] = useState(null);
  const [historyLoading, setHistoryLoading] = useState(false);

  const initials = useMemo(
    () =>
      passengerName
        .split(/\s+/)
        .map((p) => p[0])
        .join('')
        .slice(0, 2)
        .toUpperCase(),
    [passengerName]
  );

  const depPlace = placeByName(departure);
  const destPlace = placeByName(destination);
  const localFare = lookupLocalFare(departure, destination);

  // ─────────────────────────────────────────────────────────────
  // Sync active + archived bookings from the API.
  //
  // A booking is considered "archived" if:
  //   - its own status is completed / cancelled / no_show, OR
  //   - the parent trip's status is completed / cancelled / no_show
  //
  // The backend cascades the trip status onto bookings, but we also check
  // the trip directly so the row moves to the archive the moment the
  // operator completes the trip — even before the cascade commit lands.
  // ─────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    const TERMINAL = new Set(['completed', 'cancelled', 'no_show']);

    const syncArchive = async () => {
      try {
        const all = await api.myBookings({ include: 'all' });
        if (cancelled || !Array.isArray(all)) return;

        // Collect every distinct trip id referenced by a booking
        const tripIds = [
          ...new Set(
            all
              .map(
                (b) =>
                  b.trip_id ||
                  (typeof b.trip === 'object' ? b.trip?.id : b.trip)
              )
              .filter(Boolean)
          ),
        ];

        // Fetch the trip status for each (parallel, silent on failure)
        const tripStatusById = {};
        await Promise.all(
          tripIds.map(async (id) => {
            try {
              const t = await api.tripDetail(id);
              tripStatusById[id] = t?.status || null;
            } catch {
              tripStatusById[id] = null;
            }
          })
        );

        const active = [];
        const archived = [];
        for (const b of all) {
          const tripId =
            b.trip_id ||
            (typeof b.trip === 'object' ? b.trip?.id : b.trip) ||
            null;
          const tripStatus = tripId ? tripStatusById[tripId] : null;
          const isArchived =
            TERMINAL.has(b.status) ||
            (tripStatus && TERMINAL.has(tripStatus));

          // Enrich the row so the UI can show "Trip completed" instead of
          // a stale booking status.
          const enriched = { ...b, trip_status: tripStatus };
          if (isArchived) {
            archived.push(enriched);
          } else {
            active.push(enriched);
          }
        }

        if (cancelled) return;
        setMyBookings(active);
        setArchivedBookings(archived);
      } catch {
        /* ignore */
      }
    };

    syncArchive();
    const id = setInterval(syncArchive, 8000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [booked]);

  // Poll personal notifications and refresh on cancellation
  useEffect(() => {
    const load = async () => {
      try {
        const rows = await api.passengerNotifications();
        const list = Array.isArray(rows) ? rows : [];
        setPassengerNotes(list);
        const hasFreshCancel = list.some(
          (n) =>
            n.meta?.type === 'trip_cancelled' &&
            !n.read &&
            n.created_at &&
            Date.now() - new Date(n.created_at).getTime() < 60_000
        );
        if (hasFreshCancel) {
          try {
            const mine = await api.myBookings();
            setMyBookings(Array.isArray(mine) ? mine : []);
          } catch {
            /* ignore */
          }
        }
      } catch {
        setPassengerNotes([]);
      }
    };
    load();
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
  }, []);

  // Global announcements
  useEffect(() => {
    const load = () =>
      api
        .passengerAnnouncements()
        .then((rows) => setGlobalAnnouncements(Array.isArray(rows) ? rows : []))
        .catch(() => setGlobalAnnouncements([]));
    load();
    const id = setInterval(load, 60000);
    return () => clearInterval(id);
  }, []);

  // Load passenger history on demand
  useEffect(() => {
    if (deskTab !== 'history') return undefined;
    setHistoryLoading(true);
    api
      .passengerHistory()
      .then(setHistory)
      .catch(() => setHistory(null))
      .finally(() => setHistoryLoading(false));
  }, [deskTab]);

  // ─────────────────────────────────────────────────────────────
  // Live status + review-status poller for the currently-open trip.
  // Runs every 6 s and enables Rate / Complain the moment the
  // operator flips the trip to completed.
  // ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const tripId = liveTrip?.id || verifiedTrip?.raw?.id || booked?.trip_id;
    if (!tripId) {
      setLiveStatus(null);
      setStatusUpdatedAt(null);
      setReviewStatus(null);
      return undefined;
    }

    let cancelled = false;

    const tick = async () => {
      try {
        const data = await api.tripDetail(tripId);
        if (cancelled) return;
        if (data?.status) {
          setLiveStatus(data.status);
          setStatusUpdatedAt(new Date());
          setVerifiedTrip((prev) =>
            prev ? { ...prev, status: data.status } : prev
          );
        }
      } catch {
        /* silent */
      }
      try {
        const rs = await api.tripReviewStatus(tripId);
        if (!cancelled) setReviewStatus(rs);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveTrip?.id, verifiedTrip?.raw?.id, booked?.trip_id]);

  async function searchTrip() {
    if (departure === destination) {
      notify?.('Departure and destination must be different.');
      setResults([]);
      return;
    }
    setLoading(true);
    setBooked(null);
    setSelected(null);
    setAdhocLine(null);
    try {
      const trips = await api.listTrips({ from: departure, to: destination });
      let matched = (trips || []).map(mapApiTrip);
      if (!matched.length && localFare != null) {
        matched = [
          {
            id: null,
            trip_code: null,
            origin: departure,
            destination,
            departure: 'Check rank for next departure',
            status: 'info',
            operator: `${departure} Taxi Association`,
            driver: '—',
            vehicle: '—',
            registration: '—',
            fare: `R${localFare}`,
            fareNum: localFare,
            seats_available: null,
            raw: null,
            isInfoOnly: true,
          },
        ];
      }
      const corridorMatched = matched.filter((x) =>
        isOfficialCorridor(x.origin, x.destination)
      );
      const results2 = corridorMatched.length ? corridorMatched : matched;
      setResults(results2);
      if (results2.length) {
        const pick = results2.find((m) => m.raw) || results2[0];
        setSelected(pick);
      }
    } catch (e) {
      notify?.(e.message);
      setResults([]);
    } finally {
      setLoading(false);
    }
  }

  function isSecureGeoContext() {
    try {
      if (typeof window !== 'undefined' && window.isSecureContext) return true;
      const h = window.location.hostname;
      return h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
    } catch {
      return false;
    }
  }

  function rankFallbackLocation() {
    const name = selected?.origin || departure || 'Ongoye';
    const place =
      (PREDETERMINED_PLACES || []).find(
        (pl) => String(pl.name).toLowerCase() === String(name).toLowerCase()
      ) ||
      (PREDETERMINED_PLACES || []).find(
        (pl) => String(pl.name).toLowerCase() === 'ongoye'
      ) || { lat: -28.854, lng: 31.846 };
    return {
      lat: Number(place.lat),
      lng: Number(place.lng),
      source: 'rank_fallback',
    };
  }

  function readGpsOnce(timeoutMs = 12000) {
    return new Promise((resolve) => {
      if (!navigator.geolocation || !isSecureGeoContext()) {
        resolve(null);
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          resolve({
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
            source: 'gps',
          });
        },
        () => resolve(null),
        { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 5000 }
      );
    });
  }

  async function requestRide() {
    if (!selected?.raw?.id && !selected?.origin) {
      notify?.('Search and select a trip first, then request a ride.');
      return false;
    }
    setBooking(true);
    try {
      let loc = null;
      if (geo.position?.lat != null && geo.position?.lng != null) {
        loc = {
          lat: Number(geo.position.lat),
          lng: Number(geo.position.lng),
          source: 'gps',
        };
      }
      if (!loc && isSecureGeoContext()) {
        loc = await readGpsOnce(12000);
      }
      if (!loc || loc.lat == null || loc.lng == null) {
        loc = rankFallbackLocation();
      }
      const payload = {
        lat: loc.lat,
        lng: loc.lng,
        trip_id: selected.raw?.id || undefined,
        location_source: loc.source || 'gps',
      };
      const res = await api.createRideRequest(payload);
      const n = res.drivers_notified ?? 0;
      notify?.(
        n > 0
          ? `Request sent to ${n} driver(s).`
          : 'Request recorded. Open driver_demo to view it.'
      );
      return true;
    } catch (e) {
      notify?.(e.message || 'Could not send ride request.');
      return false;
    } finally {
      setBooking(false);
    }
  }

  /**
   * Opens the Active-trip panel from a booking row (active or archived).
   * For archived (completed) trips the Rate / File-complaint buttons are
   * shown inside the Trip-info card.
   */
  async function openBookingDetails(b) {
    setSelectedBookingId(b.id);
    const tripId =
      b.trip_id || (typeof b.trip === 'object' ? b.trip?.id : b.trip) || null;

    setBooked({
      booking_id: b.id,
      trip_id: tripId,
      verification_code: b.verification_code,
      trip_code: b.trip_code,
    });

    setVerifiedTrip({
      origin: b.route_from || '—',
      destination: b.route_to || '—',
      trip_code: b.trip_code,
      status: b.trip_status || b.status || 'reserved',
      fare: b.fare_paid != null ? `R${b.fare_paid}` : undefined,
      driver: b.driver_name || 'To be assigned',
      operator: b.operator_name || '—',
      departure: b.departure_date || '',
      raw: {
        id: tripId,
        trip_code: b.trip_code,
        status: b.trip_status || b.status,
      },
    });

    if (tripId) {
      try {
        await loadLiveForTrip(tripId);
        const rs = await api.tripReviewStatus(tripId).catch(() => null);
        if (rs) setReviewStatus(rs);
      } catch {
        /* ignore */
      }
    }
    setViewMode('active');
  }

  async function previewRoadRoute() {
    if (!depPlace || !destPlace) {
      notify?.('Select valid departure and destination.');
      return;
    }
    if (departure === destination) {
      notify?.('Departure and destination must be different.');
      return;
    }
    setRouting(true);
    setTaxiGeometry([]);
    setToRankGeometry([]);
    setAdhocLine(null);
    setViewMode('route');
    try {
      const gps = geo.position
        ? { lat: Number(geo.position.lat), lng: Number(geo.position.lng) }
        : null;
      const rank = { lat: depPlace.lat, lng: depPlace.lng, name: depPlace.name };
      const dest = { lat: destPlace.lat, lng: destPlace.lng, name: destPlace.name };
      let drewLeg1 = false;
      if (gps) {
        const straightKm = haversineKm(gps.lat, gps.lng, rank.lat, rank.lng);
        if (straightKm > 0.15) {
          try {
            const leg1 = await computeRoute(gps, rank);
            const g = Array.isArray(leg1.geometry) ? leg1.geometry : [];
            if (g.length >= 3) {
              setToRankGeometry(g);
              drewLeg1 = true;
            }
          } catch (err) {
            console.debug('[route] leg1 failed:', err.message);
          }
        }
      }
      try {
        const leg2 = await computeRoute(rank, dest);
        const g2 = Array.isArray(leg2.geometry) ? leg2.geometry : [];
        if (g2.length < 3) throw new Error('No road geometry returned.');
        setTaxiGeometry(g2);
        const line = polylineFromDirections({
          geometry: g2,
          distance_km: leg2.distanceKm,
          duration_min: leg2.durationMin,
          source: leg2.source,
          fare: leg2.fare,
        });
        if (line) {
          line.distanceKm = leg2.distanceKm;
          line.durationMin = leg2.durationMin;
        }
        setAdhocLine(line);
      } catch (err) {
        setTaxiGeometry([]);
        setAdhocLine(null);
        notify?.(
          err.message ||
            'Route service unavailable — could not compute rank → destination.'
        );
      }
    } catch (err) {
      notify?.(err.message || 'Routing failed.');
    } finally {
      setRouting(false);
    }
  }

  async function loadLiveForTrip(tripId) {
    if (!tripId) return;
    setLiveError('');
    try {
      const data = await api.tripLive(tripId);
      if (data?.status === 'cancelled') {
        notify?.('Trip cancelled by the operator — removed from your trips.');
        setLiveTrip(null);
        setVerifiedTrip(null);
        setBooked(null);
        setSelectedBookingId(null);
        setSelected(null);
        setAdhocLine(null);
        setTaxiGeometry([]);
        setToRankGeometry([]);
        setViewMode('desk');
        try {
          const mine = await api.myBookings();
          setMyBookings(Array.isArray(mine) ? mine : []);
        } catch {
          /* ignore */
        }
        return;
      }
      setLiveTrip(data);
      if (data?.status) {
        setLiveStatus(data.status);
        setStatusUpdatedAt(new Date());
      }
    } catch (e) {
      setLiveError(e.message);
      setLiveTrip(null);
    }
  }

  async function confirmVerifyCode() {
    const cleaned = verifyInput.trim().toUpperCase();
    if (!cleaned) {
      notify?.('Enter the verification code from the operator.');
      return;
    }
    try {
      const data = await api.verifyBookingCode(cleaned);
      const tripId = data.trip_id || data.trip?.id;
      const origin = data.origin || data.route?.departure?.name || '—';
      const destination = data.destination || data.route?.destination?.name || '—';
      const fare =
        data.fare_paid != null
          ? `R${data.fare_paid}`
          : data.route?.fare != null
            ? `R${data.route.fare}`
            : undefined;
      setBooked({
        booking_id: data.booking_id || data.id,
        trip_id: tripId,
        verification_code: data.verification_code || cleaned,
        trip_code: data.trip_code,
      });
      setVerifiedTrip({
        origin,
        destination,
        trip_code: data.trip_code,
        fare,
        driver: data.driver_name,
        operator: data.operator_name,
        status: data.trip_status || data.status,
        departure: [data.departure_date, data.expected_departure_time || '']
          .filter(Boolean)
          .join(' '),
        raw: {
          id: tripId,
          trip_code: data.trip_code,
          status: data.trip_status,
          route: data.route,
          driver_name: data.driver_name,
          operator_name: data.operator_name,
          seat_capacity: data.seat_capacity,
          seats_taken: data.seats_taken,
        },
      });
      setSelectedBookingId(data.booking_id || data.id);
      setSelected(null);
      setAdhocLine(null);
      setTaxiGeometry([]);
      setToRankGeometry([]);
      setViewMode('active');
      try {
        const mine = await api.myBookings();
        setMyBookings(Array.isArray(mine) ? mine : []);
      } catch {
        /* ignore */
      }
      notify?.(data.message || 'Trip verified — added to My bookings.');
    } catch (err) {
      notify?.(err.message || 'Invalid or expired verification code.');
    }
  }

  async function sendPanic() {
    const ok = window.confirm(
      'Send emergency alert to the operator/administrator with your trip and location?\n\nThis is not a substitute for calling emergency services.'
    );
    if (!ok) return;
    setPanicOpen(false);
    try {
      const pos = await new Promise((resolve) => {
        if (!navigator.geolocation) return resolve(null);
        navigator.geolocation.getCurrentPosition(
          (p) => resolve(p.coords),
          () => resolve(null),
          { timeout: 8000 }
        );
      });
      await api.panic({
        tripId: selected?.raw?.id || booked?.booking_id,
        type: 'PANIC_ALERT',
        departurePoint: departure,
        destination,
        latitude: pos?.latitude,
        longitude: pos?.longitude,
        accuracy: pos?.accuracy,
      });
      notify?.('Emergency alert sent to operators.');
    } catch (e) {
      notify?.(e.message);
    }
  }

  const mapOverlays = useMemo(() => {
    const tripSrc = liveTrip || selected?.raw;
    const base = tripSrc ? overlaysFromTrip(tripSrc) : { polylines: [], markers: [] };
    const lines = [...base.polylines];
    const markers = [...base.markers];
    if (Array.isArray(toRankGeometry) && toRankGeometry.length >= 3) {
      lines.push({
        id: 'to-rank',
        positions: toRankGeometry,
        color: '#38bdf8',
        weight: 4,
        dashed: true,
      });
    }
    if (Array.isArray(taxiGeometry) && taxiGeometry.length >= 3) {
      lines.push({
        id: 'taxi-corridor',
        positions: taxiGeometry,
        color: '#f5a524',
        weight: 5,
      });
    } else if (
      adhocLine &&
      Array.isArray(adhocLine.positions) &&
      adhocLine.positions.length >= 3
    ) {
      lines.push(adhocLine);
    }
    if (depPlace) {
      markers.push({
        id: 'dep',
        lat: depPlace.lat,
        lng: depPlace.lng,
        label: `Departure: ${depPlace.name}`,
        kind: 'rank',
      });
    }
    if (destPlace) {
      markers.push({
        id: 'dest',
        lat: destPlace.lat,
        lng: destPlace.lng,
        label: `Destination: ${destPlace.name}`,
        kind: 'dest',
      });
    }
    if (nearestHint) {
      markers.push({
        id: 'nearest',
        lat: nearestHint.lat,
        lng: nearestHint.lng,
        label: `Nearest rank: ${nearestHint.name}`,
        kind: 'rank',
      });
    }
    if (geo.position) {
      markers.push({
        id: 'you',
        lat: geo.position.lat,
        lng: geo.position.lng,
        label: 'You',
        kind: 'you',
        color: '#38bdf8',
      });
    }
    const live = liveTrip?.live_location;
    if (live && live.lat != null && live.lng != null) {
      markers.push({
        id: 'vehicle-live',
        lat: Number(live.lat),
        lng: Number(live.lng),
        label: liveTrip?.vehicle_plate || 'Taxi',
        kind: 'vehicle',
        color: '#22c55e',
      });
    }
    return { polylines: lines, markers };
  }, [
    selected,
    adhocLine,
    toRankGeometry,
    taxiGeometry,
    depPlace,
    destPlace,
    nearestHint,
    geo.position,
    liveTrip,
  ]);

  const brandHeader = (
    <header className="pmd-topbar">
      <div className="pmd-brand-row">
        <span className="pmd-mark">T</span>
        <div>
          <strong>TRANSIT // PASS</strong>
          <small>PASSENGER OPERATIONS PORTAL</small>
        </div>
      </div>
      <div className="pmd-user-chip">
        <span className="pmd-live-dot" /> IDENTITY VERIFIED
        <strong>{passengerName}</strong>
        <span className="pmd-avatar-sm">{initials}</span>
      </div>
    </header>
  );

  /* ========== Active trip ========== */
  if (viewMode === 'active' && verifiedTrip) {
    const vt = verifiedTrip;
    const tripId = vt?.raw?.id || liveTrip?.id || booked?.trip_id;
    const completed = reviewStatus?.completed;
    const displayStatus = liveStatus || vt.status || 'verified';
    return (
      <div className="pmd pmd-stage-active">
        {brandHeader}
        <div className="pmd-active-wrap">
          <div className="pmd-active-head">
            <button
              type="button"
              className="pmd-btn ghost"
              onClick={() => setViewMode('desk')}
            >
              ← Desk
            </button>
            <div>
              <p className="pmd-kicker">
                ACTIVE TRIP{vt.trip_code ? ` / ${vt.trip_code}` : ''}
              </p>
              <h1>
                {vt.origin || departure} → {vt.destination || destination}
              </h1>
              <p className="pmd-hint">
                Trip verified. Review vehicle and live location.
              </p>
            </div>
            <span className={`pmd-pill ${statusClass(displayStatus)}`}>
              {statusLabel(displayStatus)}
            </span>
          </div>

          <div className="pmd-active-grid">
            <div className="pmd-map-panel">
              <div className="pmd-map-badge">
                <span className="pmd-live-dot" /> LIVE ROUTE
                {liveTrip?.live_location ? ' · GPS CONNECTED' : ''}
              </div>
              <ThembaMap
                polylines={mapOverlays.polylines}
                markers={mapOverlays.markers}
                fillHeight
                fitKey={`active-${vt.trip_code}-${liveTrip?.live_location?.lat || ''}`}
              />
              <div className="pmd-map-legend">
                <span>● {departure}</span>
                <span>— {destination}</span>
              </div>
              <div className="pmd-trip-control">
                <small>TRIP CONTROL</small>
                <p>
                  {liveTrip?.vehicle_plate
                    ? `Vehicle ${liveTrip.vehicle_plate}`
                    : vt.vehicle && vt.vehicle !== '—'
                      ? `Vehicle ${vt.vehicle} ${vt.registration || ''}`.trim()
                      : 'Awaiting vehicle GPS'}
                  {liveTrip?.live_location
                    ? ' · live position on map'
                    : ' · waiting for driver GPS'}
                </p>
                {liveError && <p className="pmd-error">{liveError}</p>}
              </div>
            </div>

            <div className="pmd-active-side">
              <section className="pmd-card">
                <div className="pmd-card-head">
                  <h3>Trip information</h3>
                  <span className={`pmd-pill ${statusClass(displayStatus)}`}>
                    {statusLabel(displayStatus)}
                  </span>
                </div>
                <dl className="pmd-dl">
                  <div>
                    <dt>Fare</dt>
                    <dd>{vt.fare || (localFare != null ? `R${localFare}` : '—')}</dd>
                  </div>
                  <div>
                    <dt>Departure</dt>
                    <dd>{vt.departure || '—'}</dd>
                  </div>
                  <div>
                    <dt>Route</dt>
                    <dd>
                      {vt.origin || departure} → {vt.destination || destination}
                    </dd>
                  </div>
                  <div>
                    <dt>Vehicle</dt>
                    <dd>
                      {vt.vehicle || '—'} {vt.registration || ''}
                    </dd>
                  </div>
                  <div>
                    <dt>Driver</dt>
                    <dd>{vt.driver || '—'}</dd>
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
                          title={`Last synced ${statusUpdatedAt.toLocaleTimeString()}`}
                        >
                          ● live
                        </span>
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>Code</dt>
                    <dd>Verified</dd>
                  </div>
                </dl>

                {completed && (
                  <div className="pmd-trip-control" style={{ marginTop: 12 }}>
                    <small>TRIP COMPLETED</small>
                    <p style={{ margin: '4px 0 8px' }}>
                      You can rate the driver and file a complaint for this
                      trip — once each. After submission the buttons lock to
                      prevent duplicates.
                    </p>
                    <div className="pmd-btn-row">
                      <button
                        type="button"
                        className="pmd-btn primary"
                        disabled={!reviewStatus?.can_rate}
                        onClick={() => {
                          if (!reviewStatus?.can_rate) {
                            notify?.(
                              reviewStatus?.has_rating
                                ? 'You have already rated this trip.'
                                : 'Rating is not available yet.'
                            );
                            return;
                          }
                          setFeedbackOpen(true);
                        }}
                      >
                        {reviewStatus?.has_rating ? 'Rated ✓' : 'Rate driver'}
                      </button>
                      <button
                        type="button"
                        className="pmd-btn ghost"
                        disabled={!reviewStatus?.can_complain}
                        onClick={() => {
                          if (!reviewStatus?.can_complain) {
                            notify?.(
                              reviewStatus?.has_complaint
                                ? 'You have already filed a complaint for this trip.'
                                : 'Complaint is not available yet.'
                            );
                            return;
                          }
                          setComplaintOpen(true);
                        }}
                      >
                        {reviewStatus?.has_complaint
                          ? 'Complaint filed ✓'
                          : 'File complaint'}
                      </button>
                    </div>
                  </div>
                )}
              </section>

              <section className="pmd-card">
                <div className="pmd-card-head">
                  <h3>Safety area</h3>
                  <span className="pmd-pill muted">MONITORING ON</span>
                </div>
                <p className="pmd-hint">Emergency assistance available 24/7</p>
                <div className="pmd-btn-row">
                  <button
                    type="button"
                    className="pmd-btn danger"
                    onClick={() => setPanicOpen(true)}
                  >
                    PANIC / GET HELP
                  </button>
                </div>
              </section>
            </div>
          </div>
        </div>

        {feedbackOpen && (
          <div className="pmd-modal-backdrop" role="presentation">
            <div className="pmd-modal" role="dialog">
              <h3>Rate your driver</h3>
              <p>
                Rating must be 1–5 stars. You can only rate this trip once.
              </p>
              <label style={{ display: 'block', marginBottom: 8 }}>
                Stars
                <select
                  className="pmd-input"
                  value={feedbackScore}
                  onChange={(e) => setFeedbackScore(Number(e.target.value))}
                  style={{ marginLeft: 8 }}
                >
                  {[5, 4, 3, 2, 1].map((n) => (
                    <option key={n} value={n}>
                      {n} ★
                    </option>
                  ))}
                </select>
              </label>
              <textarea
                className="pmd-textarea"
                value={feedbackText}
                onChange={(e) => setFeedbackText(e.target.value)}
                rows={4}
                placeholder="How was the ride, driver, vehicle…? (optional)"
              />
              <div className="pmd-modal-actions">
                <button
                  type="button"
                  className="pmd-btn ghost"
                  onClick={() => setFeedbackOpen(false)}
                  disabled={feedbackBusy}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="pmd-btn primary"
                  disabled={feedbackBusy}
                  onClick={async () => {
                    if (!tripId) {
                      notify?.('No trip selected to rate.');
                      return;
                    }
                    setFeedbackBusy(true);
                    try {
                      await api.rateDriver({
                        trip_id: tripId,
                        score: feedbackScore,
                        comment: feedbackText.trim(),
                      });
                      notify?.(`Thank you — ${feedbackScore}★ rating saved.`);
                      setFeedbackText('');
                      setFeedbackScore(5);
                      setFeedbackOpen(false);
                      const rs = await api.tripReviewStatus(tripId).catch(() => null);
                      if (rs) setReviewStatus(rs);
                    } catch (err) {
                      notify?.(
                        err.message ||
                          'Could not save rating. Trip may not be completed yet.'
                      );
                    } finally {
                      setFeedbackBusy(false);
                    }
                  }}
                >
                  {feedbackBusy ? 'Saving…' : 'Submit rating'}
                </button>
              </div>
            </div>
          </div>
        )}

        {complaintOpen && (
          <div className="pmd-modal-backdrop" role="presentation">
            <div className="pmd-modal" role="dialog">
              <h3>File a complaint</h3>
              <p>
                Complaints are reviewed by the operator and can be escalated
                to the administrator. You can only file one complaint per trip.
              </p>
              <label style={{ display: 'block', marginBottom: 8 }}>
                Category
                <select
                  className="pmd-input"
                  value={complaintCategory}
                  onChange={(e) => setComplaintCategory(e.target.value)}
                  style={{ marginLeft: 8 }}
                >
                  <option value="other">Other</option>
                  <option value="misconduct">Driver misconduct</option>
                  <option value="delay">Delay</option>
                  <option value="vehicle">Vehicle issue</option>
                  <option value="safety">Safety concern</option>
                </select>
              </label>
              <textarea
                className="pmd-textarea"
                value={complaintText}
                onChange={(e) => setComplaintText(e.target.value)}
                rows={5}
                placeholder="Describe what happened on this trip…"
              />
              <div className="pmd-modal-actions">
                <button
                  type="button"
                  className="pmd-btn ghost"
                  onClick={() => setComplaintOpen(false)}
                  disabled={complaintBusy}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="pmd-btn primary"
                  disabled={complaintBusy}
                  onClick={async () => {
                    if (!tripId) {
                      notify?.('No trip selected.');
                      return;
                    }
                    if (!complaintText.trim()) {
                      notify?.('Please describe the issue.');
                      return;
                    }
                    setComplaintBusy(true);
                    try {
                      await api.fileComplaint(tripId, {
                        category: complaintCategory,
                        description: complaintText.trim(),
                      });
                      notify?.('Complaint submitted.');
                      setComplaintText('');
                      setComplaintCategory('other');
                      setComplaintOpen(false);
                      const rs = await api.tripReviewStatus(tripId).catch(() => null);
                      if (rs) setReviewStatus(rs);
                    } catch (err) {
                      notify?.(err.message || 'Could not submit complaint.');
                    } finally {
                      setComplaintBusy(false);
                    }
                  }}
                >
                  {complaintBusy ? 'Submitting…' : 'Submit complaint'}
                </button>
              </div>
            </div>
          </div>
        )}

        {panicOpen && (
          <div className="pmd-modal-backdrop" role="presentation">
            <div className="pmd-modal" role="dialog">
              <h3>Emergency alert</h3>
              <p>
                This notifies the operator/administrator with your trip and
                location. It does not replace calling emergency services.
              </p>
              <div className="pmd-modal-actions">
                <button
                  type="button"
                  className="pmd-btn ghost"
                  onClick={() => setPanicOpen(false)}
                >
                  Cancel
                </button>
                <button type="button" className="pmd-btn danger" onClick={sendPanic}>
                  Send alert
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  /* ========== Route preview ========== */
  if (viewMode === 'route') {
    return (
      <div className="pmd pmd-stage-route">
        {brandHeader}
        <div className="pmd-route-wrap">
          <div className="pmd-active-head">
            <button
              type="button"
              className="pmd-btn ghost"
              onClick={() => setViewMode('desk')}
            >
              ← Return to search
            </button>
            <div>
              <p className="pmd-kicker">ROUTE SEARCH / RESULT</p>
              <h1>
                {departure} → {destination}
              </h1>
            </div>
            <span className="pmd-pill ok">ROUTE AVAILABLE</span>
          </div>

          <div className="pmd-active-grid">
            <div className="pmd-map-panel">
              <div className="pmd-map-badge">ROUTE PREVIEW</div>
              <ThembaMap
                polylines={mapOverlays.polylines}
                markers={mapOverlays.markers}
                fillHeight
                fitKey={`route-${departure}-${destination}-${taxiGeometry.length}-${routing ? 'loading' : 'idle'}`}
              />
              {routing && (
                <div
                  style={{
                    position: 'absolute',
                    inset: 0,
                    display: 'grid',
                    placeItems: 'center',
                    background: 'rgba(7, 16, 22, 0.55)',
                    zIndex: 4,
                    fontSize: '0.9rem',
                    color: '#e8eef2',
                    pointerEvents: 'none',
                    borderRadius: 10,
                  }}
                >
                  Loading route…
                </div>
              )}
              <div className="pmd-map-legend">
                <span>● {departure}</span>
                <span>— {destination}</span>
              </div>
              <div className="pmd-stat-row">
                <div className="pmd-stat">
                  <small>ESTIMATED DISTANCE</small>
                  <strong>
                    {adhocLine?.distanceKm != null
                      ? `${Number(adhocLine.distanceKm).toFixed(1)} km`
                      : taxiGeometry.length
                        ? 'See path'
                        : '—'}
                  </strong>
                </div>
                <div className="pmd-stat">
                  <small>ESTIMATED TIME</small>
                  <strong>
                    {adhocLine?.durationMin != null
                      ? `${Math.round(adhocLine.durationMin)} min`
                      : '—'}
                  </strong>
                </div>
                <div className="pmd-stat">
                  <small>OFFICIAL FARE</small>
                  <strong>{localFare != null ? `R${localFare}` : '—'}</strong>
                </div>
              </div>
            </div>

            <div className="pmd-active-side">
              <section className="pmd-card">
                <h3>Route summary</h3>
                <dl className="pmd-dl">
                  <div>
                    <dt>Departure</dt>
                    <dd>{departure}</dd>
                  </div>
                  <div>
                    <dt>Destination</dt>
                    <dd>{destination}</dd>
                  </div>
                  <div>
                    <dt>Legs</dt>
                    <dd>
                      {toRankGeometry.length >= 3
                        ? 'You → rank → destination'
                        : 'Rank → destination'}
                    </dd>
                  </div>
                </dl>
              </section>
              <section className="pmd-card fare-card">
                <small>OFFICIAL FARE</small>
                <strong className="pmd-fare-lg">
                  {localFare != null ? `R${localFare}` : '—'}
                </strong>
                <span className="pmd-pill muted">FIXED FARE</span>
              </section>
              <button
                type="button"
                className="pmd-btn primary block"
                onClick={() => {
                  setViewMode('desk');
                  searchTrip();
                }}
                disabled={loading}
              >
                → Continue to trip search
              </button>
              <button
                type="button"
                className="pmd-btn ghost block"
                onClick={() => setViewMode('desk')}
              >
                ← Return to search
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  /* ========== Desk + History ========== */
  return (
    <div className="pmd pmd-stage-desk">
      {brandHeader}
      <div className="pmd-desk">
        <div className="pmd-desk-head">
          <div>
            <p className="pmd-kicker">PASSENGER DESK / DISCOVERY</p>
            <h1>Find and verify your trip</h1>
            <p className="pmd-hint">
              Search official routes, confirm the fare, then verify your booking code.
            </p>
          </div>
          {onExit && (
            <button type="button" className="pmd-btn ghost" onClick={onExit}>
              Sign out
            </button>
          )}
        </div>

        <div className="pmd-btn-row" style={{ marginBottom: 12 }}>
          <button
            type="button"
            className={deskTab === 'desk' ? 'pmd-btn primary' : 'pmd-btn ghost'}
            onClick={() => setDeskTab('desk')}
          >
            Desk
          </button>
          <button
            type="button"
            className={deskTab === 'history' ? 'pmd-btn primary' : 'pmd-btn ghost'}
            onClick={() => setDeskTab('history')}
          >
            History
          </button>
        </div>

        {deskTab === 'history' ? (
          <section className="pmd-card">
            <div className="pmd-card-head">
              <h3>History</h3>
              <span className="pmd-pill muted">Recent activity</span>
            </div>
            {historyLoading && <p className="pmd-muted">Loading…</p>}
            {!historyLoading && !history && (
              <p className="pmd-muted">Could not load history.</p>
            )}
            {history && (
              <>
                <div className="pmd-notif-section-label">ACTIONS</div>
                <ul className="pmd-notif-list">
                  {(history.audits || []).length === 0 && (
                    <li className="pmd-muted">No actions yet.</li>
                  )}
                  {(history.audits || []).map((a) => (
                    <li key={`a-${a.id}`} className="pmd-notif read">
                      <small>
                        {a.created_at
                          ? new Date(a.created_at).toLocaleString()
                          : ''}{' '}
                        · {a.action}
                      </small>
                      <p>{a.detail}</p>
                    </li>
                  ))}
                </ul>

                <div className="pmd-notif-section-label">COMPLAINTS</div>
                <ul className="pmd-notif-list">
                  {(history.complaints || []).length === 0 && (
                    <li className="pmd-muted">No complaints filed.</li>
                  )}
                  {(history.complaints || []).map((c) => (
                    <li key={`c-${c.id}`} className="pmd-notif read">
                      <small>
                        {c.created_at
                          ? new Date(c.created_at).toLocaleString()
                          : ''}{' '}
                        · {c.category} · {c.status}
                      </small>
                      <p>
                        Trip {c.trip_code} · Driver {c.driver_name || '—'}
                      </p>
                    </li>
                  ))}
                </ul>

                <div className="pmd-notif-section-label">RATINGS</div>
                <ul className="pmd-notif-list">
                  {(history.ratings || []).length === 0 && (
                    <li className="pmd-muted">No ratings yet.</li>
                  )}
                  {(history.ratings || []).map((r) => (
                    <li key={`r-${r.id}`} className="pmd-notif read">
                      <small>
                        {r.created_at
                          ? new Date(r.created_at).toLocaleString()
                          : ''}{' '}
                        · {r.score}★ · Trip {r.trip_code}
                      </small>
                      {r.comment && <p>{r.comment}</p>}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
        ) : (
          <>
            <div className="pmd-desk-grid">
              <section className="pmd-card">
                <h3>Search trip</h3>
                <p className="pmd-hint">
                  Enter your planned journey to check the official passenger fare.
                </p>
                {nearestHint && (
                  <div className="pmd-nearest">
                    <span>Nearest rank (GPS)</span>
                    <strong>
                      {nearestHint.name} · {nearestHint.distanceKm} km
                    </strong>
                  </div>
                )}
                <label className="pmd-label">
                  Departure
                  <select
                    value={departure}
                    onChange={(e) => setDeparture(e.target.value)}
                  >
                    {PLACES.map((pl) => (
                      <option key={pl.id} value={pl.name}>
                        {pl.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="pmd-label">
                  Destination
                  <select
                    value={destination}
                    onChange={(e) => setDestination(e.target.value)}
                  >
                    {PLACES.map((pl) => (
                      <option key={pl.id} value={pl.name}>
                        {pl.name}
                      </option>
                    ))}
                  </select>
                </label>
                {localFare != null && (
                  <div className="pmd-fare-banner">
                    <span>OFFICIAL TRIP FARE · One passenger</span>
                    <strong>R{localFare}</strong>
                  </div>
                )}
                <div className="pmd-btn-row">
                  <button
                    type="button"
                    className="pmd-btn primary"
                    onClick={searchTrip}
                    disabled={loading}
                  >
                    {loading ? 'Searching…' : 'Search trip'}
                  </button>
                  <button
                    type="button"
                    className="pmd-btn ghost"
                    onClick={previewRoadRoute}
                    disabled={routing}
                  >
                    {routing ? 'Routing…' : 'Search route'}
                  </button>
                </div>

                {results.length > 0 && (
                  <div className="pmd-desk-results">
                    <div className="pmd-results-head">
                      <span>Matching trips</span>
                      <span>{results.length}</span>
                    </div>
                    <div className="pmd-fare-block pmd-fare-auto">
                      <span>OFFICIAL TRIP FARE</span>
                      <strong>
                        {(selected && selected.fare) ||
                          results[0]?.fare ||
                          (localFare != null ? `R${localFare}` : '—')}
                      </strong>
                    </div>
                    {results.map((trip) => {
                      const rowKey =
                        trip.id != null
                          ? `trip-${trip.id}`
                          : `${trip.origin}-${trip.destination}-${trip.status}`;
                      return (
                        <button
                          key={rowKey}
                          type="button"
                          className={
                            selected &&
                            ((trip.id != null && selected.id === trip.id) ||
                              (trip.isInfoOnly &&
                                selected.isInfoOnly &&
                                selected.origin === trip.origin))
                              ? 'pmd-trip is-selected'
                              : 'pmd-trip'
                          }
                          onClick={() => setSelected(trip)}
                        >
                          <strong>
                            {trip.origin} → {trip.destination}
                          </strong>
                          <small>
                            {trip.operator}
                            {trip.fare ? ` · ${trip.fare}` : ''}
                          </small>
                          <div className="pmd-trip-meta">
                            <span>{trip.departure}</span>
                            <span className="pmd-status">{trip.status}</span>
                            <span className="pmd-trip-fare">
                              {trip.fare || '—'}
                            </span>
                          </div>
                        </button>
                      );
                    })}
                    <button
                      type="button"
                      className="pmd-btn primary block"
                      style={{ marginTop: 12 }}
                      onClick={requestRide}
                      disabled={booking || !selected}
                    >
                      {booking ? 'Requesting…' : 'Request a trip'}
                    </button>
                  </div>
                )}
              </section>

              <section className="pmd-card">
                <h3>Verify a booked trip</h3>
                <p className="pmd-hint">
                  Enter the verification code from the operator (or your booking).
                </p>
                <label className="pmd-label">
                  Trip verification code
                  <input
                    value={verifyInput}
                    onChange={(e) => setVerifyInput(e.target.value.toUpperCase())}
                    placeholder="e.g. code from booking"
                    onKeyDown={(e) => e.key === 'Enter' && confirmVerifyCode()}
                  />
                </label>
                <button
                  type="button"
                  className="pmd-btn primary block"
                  onClick={confirmVerifyCode}
                >
                  Verify trip
                </button>
              </section>
            </div>

            <div className="pmd-desk-grid pmd-desk-lower">
              <section className="pmd-card pmd-bookings">
                <div className="pmd-card-head">
                  <h3>My bookings</h3>
                  <span className="pmd-pill muted">
                    {(myBookings || []).length} trip
                    {(myBookings || []).length === 1 ? '' : 's'}
                  </span>
                </div>
                {(myBookings || []).length === 0 && (
                  <p className="pmd-hint">No active trips.</p>
                )}
                <ul className="pmd-booking-list">
                  {(myBookings || []).map((b) => (
                    <li key={b.id}>
                      <button
                        type="button"
                        className={
                          selectedBookingId === b.id
                            ? 'pmd-booking-row active'
                            : 'pmd-booking-row'
                        }
                        onClick={() => openBookingDetails(b)}
                      >
                        <span style={{ textAlign: 'left', flex: 1 }}>
                          <strong>{b.trip_code || `BK-${b.id}`}</strong>
                          <small style={{ display: 'block', marginTop: 2 }}>
                            {(b.route_from || '—')} → {(b.route_to || '—')}
                          </small>
                          <small style={{ display: 'block', opacity: 0.85 }}>
                            Status:{' '}
                            <em>
                              {(b.status || 'reserved')
                                .toString()
                                .replace(/_/g, ' ')}
                            </em>
                            {b.departure_date ? ` · ${b.departure_date}` : ''}
                          </small>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>

                <div style={{ marginTop: 12 }}>
                  <button
                    type="button"
                    className="pmd-btn ghost"
                    style={{
                      width: '100%',
                      padding: '6px 10px',
                      fontSize: '0.75rem',
                    }}
                    onClick={() => setShowArchive((v) => !v)}
                  >
                    {showArchive
                      ? '▲ Hide archived trips'
                      : '▼ Show archived trips'}
                  </button>
                  {showArchive && (
                    <ul
                      className="pmd-booking-list"
                      style={{ marginTop: 8, opacity: 0.85 }}
                    >
                      {(archivedBookings || []).length === 0 && (
                        <li className="pmd-muted" style={{ padding: '6px 0' }}>
                          No archived trips yet.
                        </li>
                      )}
                      {(archivedBookings || []).map((b) => (
                        <li key={`arch-${b.id}`}>
                          <button
                            type="button"
                            className="pmd-booking-row"
                            style={{
                              borderStyle: 'dashed',
                              opacity: 0.9,
                            }}
                            onClick={() => openBookingDetails(b)}
                          >
                            <span style={{ textAlign: 'left', flex: 1 }}>
                              <strong>{b.trip_code || `BK-${b.id}`}</strong>
                              <small style={{ display: 'block', marginTop: 2 }}>
                                {(b.route_from || '—')} → {b.route_to || '—'}
                              </small>
                              <small style={{ display: 'block' }}>
                                Status:{' '}
                                <em
                                  style={{
                                    color:
                                      b.status === 'cancelled' ||
                                      b.trip_status === 'cancelled'
                                        ? '#f87171'
                                        : '#8b9bb0',
                                    fontStyle: 'normal',
                                  }}
                                >
                                  {b.trip_status || b.status}
                                </em>
                                {b.departure_date
                                  ? ` · ${b.departure_date}`
                                  : ''}
                                {(b.trip_status === 'completed' ||
                                  b.status === 'completed') && (
                                  <span
                                    style={{
                                      marginLeft: 6,
                                      color: '#4ade80',
                                      fontSize: '0.68rem',
                                    }}
                                  >
                                    · tap to rate / complain
                                  </span>
                                )}
                              </small>
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </section>

              <section className="pmd-card">
                <div className="pmd-card-head">
                  <h3>Notifications</h3>
                  <span className="pmd-pill muted">
                    {(globalAnnouncements || []).length +
                      (passengerNotes || []).filter((n) => !n.read).length}
                  </span>
                </div>
                {(globalAnnouncements || []).length > 0 && (
                  <>
                    <div className="pmd-notif-section-label">
                      SYSTEM · FROM ADMIN
                    </div>
                    <ul className="pmd-notif-list">
                      {(globalAnnouncements || []).slice(0, 6).map((a) => (
                        <li key={`sys-${a.id}`} className="pmd-notif unread">
                          <small>
                            <span className="pmd-notif-badge">SYSTEM</span>
                            {a.when
                              ? ` · ${new Date(a.when).toLocaleString()}`
                              : ''}
                          </small>
                          <strong style={{ display: 'block', marginTop: 2 }}>
                            {a.title}
                          </strong>
                          <p>{a.body}</p>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                <div className="pmd-notif-section-label">MY UPDATES</div>
                <ul className="pmd-notif-list">
                  {(passengerNotes || []).length === 0 && (
                    <li className="pmd-muted">No messages yet.</li>
                  )}
                  {(passengerNotes || []).slice(0, 8).map((n) => (
                    <li
                      key={n.id}
                      className={n.read ? 'pmd-notif read' : 'pmd-notif unread'}
                    >
                      <small>
                        {n.created_at
                          ? new Date(n.created_at).toLocaleTimeString([], {
                              hour: '2-digit',
                              minute: '2-digit',
                            })
                          : ''}{' '}
                        · {n.title}
                      </small>
                      <p>{n.body}</p>
                    </li>
                  ))}
                </ul>
              </section>
            </div>
          </>
        )}
      </div>
    </div>
  );
}