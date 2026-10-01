/**
 * RankFlow Operator Console — rank-scoped trip queue, confirm access,
 * register passenger, announcements, complaints, drivers, panic, history.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, getUser } from '../api';
import ThemeToggle from '../components/ThemeToggle.jsx';
import '../styles/rankflowOperator.css';

const NAV = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'queue', label: 'Trip queue' },
  { id: 'announcements', label: 'Announcements' },
  { id: 'complaints', label: 'Complaints' },
  { id: 'drivers', label: 'Driver & vehicle' },
  { id: 'panics', label: 'Panic alerts' },
  { id: 'history', label: 'History' },
];

function fmtTime(t) {
  if (!t) return '—';
  const s = String(t);
  return s.length >= 5 ? s.slice(0, 5) : s;
}

export default function RankFlowOperatorPage({ notify, onExit }) {
  const user = getUser();
  const [tab, setTab] = useState('dashboard');
  const [dash, setDash] = useState(null);
  const [trips, setTrips] = useState([]);
  const [pendingTrip, setPendingTrip] = useState(null);
  const [activeTrip, setActiveTrip] = useState(null);
  const [manifest, setManifest] = useState(null);
  const [anns, setAnns] = useState([]);
  const [editAnn, setEditAnn] = useState(null);
  const [complaints, setComplaints] = useState([]);
  const [selComplaint, setSelComplaint] = useState(null);
  const [drivers, setDrivers] = useState([]);
  const [selDriver, setSelDriver] = useState(null);
  const [panics, setPanics] = useState([]);
  const [history, setHistory] = useState([]);
  const [busy, setBusy] = useState(false);

  const [regForm, setRegForm] = useState({
    first_name: '',
    surname: '',
    next_of_kin_name: '',
    next_of_kin_phone: '',
  });

  const [issuedCode, setIssuedCode] = useState(null);
  const [showRegister, setShowRegister] = useState(false);
  const [statusFilter, setStatusFilter] = useState('');

  const loadDash = useCallback(async () => {
    try {
      setDash(await api.operatorDashboard());
    } catch (e) {
      notify?.(e.message);
    }
  }, [notify]);

  const loadQueue = useCallback(async () => {
    try {
      const t = await api.myTrips();
      setTrips(Array.isArray(t) ? t : []);
    } catch (e) {
      notify?.(e.message);
    }
  }, [notify]);

  const loadAnns = useCallback(async () => {
    try {
      const a = await api.listAnnouncements();
      setAnns(Array.isArray(a) ? a : []);
    } catch (e) {
      notify?.(e.message);
    }
  }, [notify]);

  const loadComplaints = useCallback(async () => {
    try {
      setComplaints(await api.operatorComplaints());
    } catch (e) {
      notify?.(e.message);
    }
  }, [notify]);

  const loadDrivers = useCallback(async () => {
    try {
      setDrivers(await api.operatorDrivers());
    } catch (e) {
      notify?.(e.message);
    }
  }, [notify]);

  const loadPanics = useCallback(async () => {
    try {
      setPanics(await api.operatorPanics());
    } catch (e) {
      notify?.(e.message);
    }
  }, [notify]);

  const loadHistory = useCallback(async () => {
    try {
      setHistory(await api.history());
    } catch (e) {
      notify?.(e.message);
    }
  }, [notify]);

  useEffect(() => {
    const map = {
      dashboard: () => {
        loadDash();
        loadQueue();
      },
      queue: loadQueue,
      announcements: loadAnns,
      complaints: loadComplaints,
      drivers: loadDrivers,
      panics: loadPanics,
      history: loadHistory,
    };
    map[tab]?.();
  }, [
    tab,
    loadDash,
    loadQueue,
    loadAnns,
    loadComplaints,
    loadDrivers,
    loadPanics,
    loadHistory,
  ]);

  const filteredTrips = useMemo(() => {
    if (!statusFilter) return trips;
    return trips.filter((t) => String(t.status).toLowerCase() === statusFilter);
  }, [trips, statusFilter]);

  async function openTrip(t) {
    setShowRegister(false);
    setIssuedCode(null);
    setManifest(null);

    const alreadyEngaged = Boolean(
      t?.is_engaged ||
        t?.engaged_at ||
        t?.engaged_by_id ||
        t?.status === 'boarding' ||
        t?.status === 'in_progress'
    );

    if (alreadyEngaged) {
      try {
        const fresh = await api.tripDetail(t.id).catch(() => null);
        const m = await api.manifest(t.id);
        setActiveTrip(fresh || t);
        setManifest(m);
        return;
      } catch (e) {
        console.debug(
          '[openTrip] manifest failed, showing confirm panel:',
          e.message
        );
      }
    }

    setPendingTrip(t);
    setActiveTrip(null);
  }

  async function confirmTrip() {
    if (!pendingTrip) return;
    setBusy(true);
    try {
      const t = await api.confirmTripAccess(pendingTrip.id);
      setActiveTrip(t);
      setPendingTrip(null);
      const m = await api.manifest(t.id);
      setManifest(m);
      notify?.('Trip access confirmed — recorded in history.');

      setTrips((prev) =>
        prev.map((row) =>
          row.id === t.id
            ? {
                ...row,
                is_engaged: true,
                engaged_at: t.engaged_at,
                status: t.status,
              }
            : row
        )
      );
      await loadQueue();
    } catch (e) {
      notify?.(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function cancelTrip() {
    if (!activeTrip) return;
    const reason = window.prompt(
      'Reason for cancelling this trip?\n\nAll bookings will be cancelled and passengers notified.'
    );
    if (reason === null) return;
    setBusy(true);
    try {
      const res = await api.cancelTrip(activeTrip.id, reason || '');
      notify?.(res.message || 'Trip cancelled.');
      setActiveTrip(null);
      setManifest(null);
      setShowRegister(false);
      setTab('queue');
      await loadQueue();
      await loadDash();
    } catch (e) {
      notify?.(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function registerPassenger(e) {
    e?.preventDefault?.();
    if (!activeTrip) return;

    if (!regForm.next_of_kin_name.trim()) {
      notify?.('Next of kin — name is required.');
      return;
    }
    if (!regForm.next_of_kin_phone.trim()) {
      notify?.('Next of kin — phone is required.');
      return;
    }

    setBusy(true);
    try {
      const data = await api.walkIn(activeTrip.id, {
        first_name: regForm.first_name,
        surname: regForm.surname,
        name: `${regForm.first_name} ${regForm.surname}`.trim(),
        next_of_kin_name: regForm.next_of_kin_name,
        next_of_kin_phone: regForm.next_of_kin_phone,
      });
      setIssuedCode(data.verification_code || data.code || '—');
      notify?.('Passenger registered — give them the verification code.');

      const m = await api.manifest(activeTrip.id);
      setManifest(m);
      setRegForm({
        first_name: '',
        surname: '',
        next_of_kin_name: '',
        next_of_kin_phone: '',
      });
    } catch (err) {
      notify?.(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function saveAnn(e) {
    e?.preventDefault?.();
    if (!editAnn) return;
    setBusy(true);
    try {
      await api.updateAnnouncement(editAnn.id, {
        topic: editAnn.topic,
        message: editAnn.message,
      });
      notify?.('Announcement updated');
      setEditAnn(null);
      await loadAnns();
    } catch (err) {
      notify?.(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function deactivateAnn(id) {
    if (!window.confirm('Deactivate this announcement?')) return;
    setBusy(true);
    try {
      await api.updateAnnouncement(id, { deactivate: true });
      notify?.('Announcement deactivated');
      setEditAnn(null);
      await loadAnns();
    } catch (e) {
      notify?.(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function reviewComplaint(id, status) {
    setBusy(true);
    try {
      await api.operatorComplaintReview
        ? api.operatorComplaintReview(id, { status })
        : Promise.resolve();
      notify?.(`Complaint marked ${status}`);
      await loadComplaints();
      setSelComplaint(null);
    } catch (e) {
      notify?.(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function escalateComplaint(id) {
    const reason = window.prompt('Reason for escalation to admin?');
    if (!reason) return;
    setBusy(true);
    try {
      await api.escalateComplaint(id, reason);
      notify?.('Complaint escalated — admin will prioritise it.');
      await loadComplaints();
      setSelComplaint(null);
    } catch (e) {
      notify?.(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function verifyAssets() {
    if (!activeTrip) return;
    setBusy(true);
    try {
      await api.verifyTripAssets(activeTrip.id);
      notify?.('Driver & vehicle verification recorded.');
    } catch (e) {
      notify?.(e.message);
    } finally {
      setBusy(false);
    }
  }

  const name =
    [user?.first_name, user?.last_name].filter(Boolean).join(' ') ||
    user?.username ||
    'Operator';
  const rankLabel = dash?.ranks?.[0]?.name || 'Assigned rank';

  if (pendingTrip) {
    const r = pendingTrip.route || {};
    const dep = r.departure?.name || r.departure_name || '—';
    const dest = r.destination?.name || r.destination_name || '—';
    return (
      <div className="ro-shell">
        <aside className="ro-nav">
          <div className="ro-brand">
            <span className="ro-brand-mark" />
            RANKFLOW OPS
          </div>
          {NAV.map((n) => (
            <button
              key={n.id}
              type="button"
              className={n.id === 'queue' ? 'active' : ''}
            >
              {n.label}
            </button>
          ))}
          <div className="ro-nav-foot">
            <strong>{name}</strong>
            <br />
            {rankLabel}
            <br />
            Rank-scoped access
          </div>
        </aside>
        <main className="ro-main">
          <div
            style={{
              display: 'flex',
              justifyContent: 'flex-end',
              marginBottom: 12,
            }}
          >
            <ThemeToggle />
          </div>
          <h1>Confirm trip access</h1>
          <div className="ro-card" style={{ maxWidth: 480, marginTop: 24 }}>
            <h3 style={{ marginTop: 0 }}>I&apos;m working this trip</h3>
            <p className="ro-muted">
              Confirm you are the assigned rank operator before viewing passengers
              or registering walk-ins.
            </p>
            <div
              style={{
                background: '#0b1220',
                borderRadius: 12,
                padding: 14,
                margin: '14px 0',
              }}
            >
              <span className={`ro-pill ${pendingTrip.status}`}>
                {pendingTrip.status}
              </span>
              <div style={{ marginTop: 8, fontWeight: 700 }}>
                {dep} → {dest}
              </div>
              <div className="ro-muted">
                {pendingTrip.departure_date} ·{' '}
                {fmtTime(pendingTrip.expected_departure_time)} ·{' '}
                {pendingTrip.trip_code}
              </div>
            </div>
            <p className="ro-muted" style={{ fontSize: '0.78rem' }}>
              Your operator ID, confirmation time, and passenger actions are
              recorded in the history log.
            </p>
            <div className="ro-actions">
              <button
                type="button"
                className="ro-btn primary"
                disabled={busy}
                onClick={confirmTrip}
              >
                Confirm trip
              </button>
              <button
                type="button"
                className="ro-btn ghost"
                onClick={() => {
                  setPendingTrip(null);
                  setTab('queue');
                }}
              >
                Not now — return to trip manifest
              </button>
            </div>
          </div>
        </main>
      </div>
    );
  }

  if (activeTrip && !showRegister) {
    const r = activeTrip.route || manifest?.route || {};
    const dep = r.departure?.name || '—';
    const dest = r.destination?.name || '—';
    const passengers = [
      ...(manifest?.booked_passengers || []),
      ...(manifest?.walk_in_passengers || []),
    ];
    return (
      <div className="ro-shell">
        <aside className="ro-nav">
          <div className="ro-brand">
            <span className="ro-brand-mark" />
            RANKFLOW OPS
          </div>
          {NAV.map((n) => (
            <button
              key={n.id}
              type="button"
              className={n.id === 'queue' ? 'active' : ''}
              onClick={() => {
                setActiveTrip(null);
                setTab(n.id);
              }}
            >
              {n.label}
            </button>
          ))}
          <div className="ro-nav-foot">
            <strong>{name}</strong>
            <br />
            {rankLabel}
          </div>
        </aside>
        <main className="ro-main">
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 12,
            }}
          >
            <button
              type="button"
              className="ro-btn ghost"
              onClick={() => {
                setActiveTrip(null);
                setManifest(null);
                setTab('queue');
              }}
            >
              ← Trip queue
            </button>
            <ThemeToggle />
          </div>
          <h1>Trip information</h1>
          <div className="ro-banner">
            Trip access confirmed · {activeTrip.trip_code}
          </div>
          <div className="ro-grid2">
            <div className="ro-card">
              <h3 style={{ marginTop: 0 }}>
                {dep} → {dest}
              </h3>
              <p className="ro-muted">
                {activeTrip.departure_date} ·{' '}
                {fmtTime(activeTrip.expected_departure_time)}
              </p>
              <div className="ro-stats">
                <div className="ro-stat">
                  <span>Capacity</span>
                  <strong>
                    {activeTrip.seats_taken ?? passengers.length}/
                    {activeTrip.seat_capacity ?? '—'}
                  </strong>
                </div>
                <div className="ro-stat">
                  <span>Status</span>
                  <strong>{activeTrip.status}</strong>
                </div>
              </div>
              <h4>Passenger manifest</h4>
              {passengers.length === 0 && (
                <p className="ro-muted">No passengers yet.</p>
              )}
              {passengers.map((p) => (
                <div
                  key={p.booking_id}
                  className="ro-list-row"
                  style={{ cursor: 'default' }}
                >
                  <div>
                    <strong>{p.name}</strong>
                    <div className="ro-muted">
                      {p.walk_in && p.next_of_kin_phone ? (
                        <>Next of kin: {p.next_of_kin_name || '—'} · {p.next_of_kin_phone}</>
                      ) : (
                        <>{p.phone || '—'}</>
                      )}
                    </div>
                  </div>
                  <span
                    className={`ro-pill ${p.code_verified ? 'verified' : ''}`}
                  >
                    {p.code_verified
                      ? 'VERIFIED'
                      : p.verification_code
                        ? 'CODE PENDING'
                        : p.status}
                  </span>
                </div>
              ))}
              <button
                type="button"
                className="ro-btn primary"
                style={{ marginTop: 12 }}
                onClick={() => {
                  setShowRegister(true);
                  setIssuedCode(null);
                }}
              >
                Register passenger
              </button>
            </div>
            <div>
              <div className="ro-card">
                <h4 style={{ marginTop: 0 }}>Driver & vehicle</h4>
                <p>
                  <strong>
                    {manifest?.driver_name || activeTrip.driver_name || '—'}
                  </strong>
                </p>
                <p className="ro-muted">
                  {manifest?.vehicle_plate || activeTrip.vehicle_plate || '—'}
                </p>
                <div className="ro-actions">
                  <button
                    type="button"
                    className="ro-btn primary"
                    disabled={busy}
                    onClick={verifyAssets}
                  >
                    Verify driver & vehicle
                  </button>
                  <button
                    type="button"
                    className="ro-btn ghost"
                    onClick={() => {
                      setTab('drivers');
                      setActiveTrip(null);
                    }}
                  >
                    View driver details
                  </button>
                </div>
              </div>
              <div className="ro-card">
                <h4 style={{ marginTop: 0 }}>Operator actions</h4>
                <div className="ro-actions">
                  <button
                    type="button"
                    className="ro-btn primary"
                    onClick={() => setShowRegister(true)}
                  >
                    Register passenger
                  </button>
                  <button
                    type="button"
                    className="ro-btn danger"
                    disabled={busy}
                    onClick={cancelTrip}
                  >
                    Cancel trip
                  </button>
                </div>
                <p
                  className="ro-muted"
                  style={{ fontSize: '0.75rem', marginTop: 8 }}
                >
                  Cancelling releases this trip, cancels all bookings, and
                  notifies every passenger and the assigned driver.
                </p>
              </div>
            </div>
          </div>
        </main>
      </div>
    );
  }

  if (activeTrip && showRegister) {
    return (
      <div className="ro-shell">
        <aside className="ro-nav">
          <div className="ro-brand">
            <span className="ro-brand-mark" />
            RANKFLOW OPS
          </div>
          {NAV.map((n) => (
            <button
              key={n.id}
              type="button"
              className={n.id === 'queue' ? 'active' : ''}
            >
              {n.label}
            </button>
          ))}
        </aside>
        <main className="ro-main">
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 12,
            }}
          >
            <button
              type="button"
              className="ro-btn ghost"
              onClick={() => setShowRegister(false)}
            >
              ← Trip information
            </button>
            <ThemeToggle />
          </div>
          <h1>Register passenger</h1>
          <p className="ro-muted">
            Walk-in passengers are recorded with a next-of-kin contact in place of
            mobile / ID. The system issues a verification code the passenger can
            use in the THEMBA app to claim the seat.
          </p>
          <div className="ro-grid2">
            <div className="ro-card">
              <form className="ro-form" onSubmit={registerPassenger}>
                <label>
                  First name
                  <input
                    required
                    value={regForm.first_name}
                    onChange={(e) =>
                      setRegForm({ ...regForm, first_name: e.target.value })
                    }
                  />
                </label>
                <label>
                  Surname
                  <input
                    required
                    value={regForm.surname}
                    onChange={(e) =>
                      setRegForm({ ...regForm, surname: e.target.value })
                    }
                  />
                </label>
                <label>
                  Next of kin — name
                  <input
                    required
                    value={regForm.next_of_kin_name}
                    onChange={(e) =>
                      setRegForm({
                        ...regForm,
                        next_of_kin_name: e.target.value,
                      })
                    }
                    placeholder="e.g. Thandi Mkhize"
                  />
                </label>
                <label>
                  Next of kin — phone
                  <input
                    required
                    value={regForm.next_of_kin_phone}
                    onChange={(e) =>
                      setRegForm({
                        ...regForm,
                        next_of_kin_phone: e.target.value,
                      })
                    }
                    placeholder="e.g. 0821111111"
                  />
                </label>
                <div className="full ro-actions">
                  <button
                    type="submit"
                    className="ro-btn primary"
                    disabled={busy}
                  >
                    Register and generate code
                  </button>
                </div>
              </form>
            </div>
            {issuedCode && (
              <div className="ro-card">
                <h4>Passenger registered</h4>
                <p className="ro-muted">
                  Communicate this verification code to the passenger.
                </p>
                <div className="ro-code">{issuedCode}</div>
                <button
                  type="button"
                  className="ro-btn primary"
                  style={{ marginTop: 12, width: '100%' }}
                  onClick={() => {
                    navigator.clipboard?.writeText(issuedCode);
                    notify?.('Code copied');
                  }}
                >
                  Copy code
                </button>
              </div>
            )}
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="ro-shell">
      <aside className="ro-nav">
        <div className="ro-brand">
          <span className="ro-brand-mark" />
          RANKFLOW OPS
        </div>
        {NAV.map((n) => (
          <button
            key={n.id}
            type="button"
            className={tab === n.id ? 'active' : ''}
            onClick={() => setTab(n.id)}
          >
            {n.label}
            {n.id === 'panics' && panics.length > 0 ? ` (${panics.length})` : ''}
          </button>
        ))}
        <div className="ro-nav-foot">
          <strong>{name}</strong>
          <br />
          {rankLabel}
          <br />
          <span style={{ color: '#4ade80' }}>● Rank-scoped access</span>
          {typeof onExit === 'function' && (
            <button
              type="button"
              className="ro-btn ghost"
              style={{ marginTop: 12, width: '100%' }}
              onClick={onExit}
            >
              Sign out
            </button>
          )}
        </div>
      </aside>

      <main className="ro-main">
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            marginBottom: 12,
          }}
        >
          <ThemeToggle />
        </div>

        {tab === 'dashboard' && (
          <>
            <h1>Good day, {user?.first_name || name}</h1>
            <div className="ro-stats">
              <div className="ro-stat">
                <span>Trips today</span>
                <strong>{dash?.trips_today ?? '—'}</strong>
              </div>
              <div className="ro-stat">
                <span>Passengers registered</span>
                <strong>{dash?.passengers_registered ?? '—'}</strong>
              </div>
              <div className="ro-stat">
                <span>Queue</span>
                <strong>{dash?.queue_count ?? trips.length}</strong>
              </div>
              <div className="ro-stat">
                <span>Active alerts</span>
                <strong>{dash?.active_alerts ?? panics.length}</strong>
              </div>
            </div>
            <div className="ro-card">
              <h3>Operator workspace</h3>
              {[
                ['queue', 'Trip queue'],
                ['announcements', 'Announcements'],
                ['complaints', 'Complaints'],
                ['drivers', 'Driver & vehicle'],
                ['panics', 'Panic alerts'],
              ].map(([id, label]) => (
                <div
                  key={id}
                  className="ro-list-row"
                  onClick={() => setTab(id)}
                >
                  <strong>{label}</strong>
                  <span>›</span>
                </div>
              ))}
            </div>
          </>
        )}

        {tab === 'queue' && (
          <>
            <h1>Trip queue</h1>
            <div className="ro-actions" style={{ marginBottom: 12 }}>
              {['', 'scheduled', 'boarding', 'in_progress', 'cancelled'].map(
                (s) => (
                  <button
                    key={s || 'all'}
                    type="button"
                    className={`ro-btn ${
                      statusFilter === s ? 'primary' : 'ghost'
                    }`}
                    onClick={() => setStatusFilter(s)}
                  >
                    {s ? s.replace('_', ' ') : 'All'}
                  </button>
                )
              )}
              <button
                type="button"
                className="ro-btn ghost"
                onClick={loadQueue}
              >
                Refresh
              </button>
            </div>
            <div className="ro-card">
              <table className="ro-table">
                <thead>
                  <tr>
                    <th>Trip / route</th>
                    <th>Departure</th>
                    <th>Capacity</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {filteredTrips.length === 0 && (
                    <tr>
                      <td colSpan={5} className="ro-muted">
                        No trips in your rank queue. Admin must schedule trips
                        departing from your rank.
                      </td>
                    </tr>
                  )}
                  {filteredTrips.map((t) => {
                    const r = t.route || {};
                    const dep = r.departure?.name || r.departure_name || '—';
                    const dest =
                      r.destination?.name || r.destination_name || '—';
                    return (
                      <tr key={t.id}>
                        <td>
                          <strong>
                            {dep} → {dest}
                          </strong>
                          <div className="ro-muted">{t.trip_code}</div>
                        </td>
                        <td>
                          {t.departure_date}
                          <div className="ro-muted">
                            {fmtTime(t.expected_departure_time)}
                          </div>
                        </td>
                        <td>
                          {t.seats_taken ?? 0}/{t.seat_capacity ?? '—'}
                        </td>
                        <td>
                          <span className={`ro-pill ${t.status}`}>
                            {t.status}
                          </span>
                        </td>
                        <td>
                          <button
                            type="button"
                            className="ro-btn primary"
                            onClick={() => openTrip(t)}
                          >
                            Open
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}

        {tab === 'announcements' && (
          <>
            <h1>Announcement manifest</h1>
            <div className="ro-card">
              {anns.length === 0 && (
                <p className="ro-muted">No announcements.</p>
              )}
              {anns.map((a) => (
                <div key={a.id} className="ro-list-row">
                  <div>
                    <strong>{a.topic}</strong>
                    <div className="ro-muted">
                      {a.status} · reach {a.reach_count ?? 0}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="ro-btn ghost"
                    onClick={() => setEditAnn({ ...a })}
                  >
                    View
                  </button>
                </div>
              ))}
            </div>
            {editAnn && (
              <div className="ro-card">
                <h3>Announcement detail</h3>
                <form className="ro-form" onSubmit={saveAnn}>
                  <label className="full">
                    Title
                    <input
                      value={editAnn.topic || ''}
                      onChange={(e) =>
                        setEditAnn({ ...editAnn, topic: e.target.value })
                      }
                    />
                  </label>
                  <label className="full">
                    Message
                    <textarea
                      value={editAnn.message || ''}
                      onChange={(e) =>
                        setEditAnn({ ...editAnn, message: e.target.value })
                      }
                    />
                  </label>
                  <div className="full ro-actions">
                    <button
                      type="submit"
                      className="ro-btn primary"
                      disabled={busy}
                    >
                      Update announcement
                    </button>
                    <button
                      type="button"
                      className="ro-btn danger"
                      disabled={busy}
                      onClick={() => deactivateAnn(editAnn.id)}
                    >
                      Deactivate
                    </button>
                    <button
                      type="button"
                      className="ro-btn ghost"
                      onClick={() => setEditAnn(null)}
                    >
                      Close
                    </button>
                  </div>
                </form>
              </div>
            )}
          </>
        )}

        {tab === 'complaints' && (
          <>
            <h1>Complaints queue</h1>
            <div className="ro-grid2">
              <div className="ro-card">
                <h3>Awaiting review</h3>
                {complaints.length === 0 && (
                  <p className="ro-muted">No complaints in scope.</p>
                )}
                {complaints.map((c) => (
                  <div
                    key={c.id}
                    className="ro-list-row"
                    onClick={() => setSelComplaint(c)}
                  >
                    <div>
                      <strong>{c.category}</strong>
                      <div className="ro-muted">
                        {c.driver_name} · {c.trip_code || c.trip_id}
                      </div>
                    </div>
                    <span className="ro-pill">{c.status}</span>
                  </div>
                ))}
              </div>
              {selComplaint && (
                <div className="ro-card">
                  <h3>Complaint #{selComplaint.id}</h3>
                  <p>{selComplaint.description}</p>
                  <p className="ro-muted">
                    Driver: {selComplaint.driver_name} · Trip:{' '}
                    {selComplaint.trip_code}
                  </p>
                  <div className="ro-actions">
                    <button
                      type="button"
                      className="ro-btn primary"
                      disabled={busy}
                      onClick={() =>
                        reviewComplaint(
                          selComplaint.id,
                          'operator_reviewing'
                        )
                      }
                    >
                      Mark reviewed
                    </button>
                    <button
                      type="button"
                      className="ro-btn"
                      disabled={busy}
                      onClick={() =>
                        reviewComplaint(selComplaint.id, 'resolved')
                      }
                    >
                      Resolve
                    </button>
                    <button
                      type="button"
                      className="ro-btn danger"
                      disabled={busy}
                      onClick={() => escalateComplaint(selComplaint.id)}
                    >
                      Escalate complaint
                    </button>
                    <button
                      type="button"
                      className="ro-btn ghost"
                      onClick={() => setSelComplaint(null)}
                    >
                      Close
                    </button>
                  </div>
                </div>
              )}
            </div>
          </>
        )}

        {tab === 'drivers' && (
          <>
            <h1>Association drivers</h1>
            <p className="ro-muted">
              Drivers currently assigned to trips departing from your rank.
            </p>
            <div className="ro-card">
              {drivers.length === 0 && (
                <p className="ro-muted">No drivers on ranked trips yet.</p>
              )}
              {drivers.map((d) => (
                <div
                  key={d.id}
                  className="ro-list-row"
                  onClick={() => setSelDriver(d)}
                >
                  <div>
                    <strong>{d.name}</strong>
                    <div className="ro-muted">
                      Licence {d.license_number} · {d.complaints_count}{' '}
                      complaints
                      {d.rank_name ? ` · Rank ${d.rank_name}` : ''}
                    </div>
                  </div>
                  <span className="ro-pill">{d.status}</span>
                </div>
              ))}
            </div>
            {selDriver && (
              <div className="ro-card">
                <h3>Extended driver information</h3>
                <p>
                  <strong>{selDriver.name}</strong>
                </p>
                <p className="ro-muted">Phone: {selDriver.phone || '—'}</p>
                <p className="ro-muted">
                  Licence: {selDriver.license_number}
                </p>
                <p className="ro-muted">
                  Complaints: {selDriver.complaints_count}
                </p>
                <p className="ro-muted">
                  Vehicle: {selDriver.vehicle_plate || '—'} · Trip{' '}
                  {selDriver.trip_code || '—'}
                </p>
                <p className="ro-muted">
                  Operating rank: {selDriver.rank_name || '—'}
                </p>
                {selDriver.trip_id && (
                  <button
                    type="button"
                    className="ro-btn primary"
                    disabled={busy}
                    onClick={async () => {
                      try {
                        await api.verifyTripAssets(selDriver.trip_id);
                        notify?.(
                          'Verification recorded for this assignment.'
                        );
                      } catch (e) {
                        notify?.(e.message);
                      }
                    }}
                  >
                    Verify driver & vehicle
                  </button>
                )}
              </div>
            )}
          </>
        )}

        {tab === 'panics' && (
          <>
            <h1>Panic button alerts</h1>
            <div className="ro-card">
              {panics.length === 0 && (
                <p className="ro-muted">No panic alerts.</p>
              )}
              {panics.map((p) => (
                <div
                  key={p.id}
                  className="ro-list-row"
                  style={{ cursor: 'default' }}
                >
                  <div>
                    <strong className="ro-pill critical">PANIC</strong>{' '}
                    {p.user_name || p.user || 'Passenger'}
                    <div className="ro-muted">
                      Trip {p.trip_code || p.trip_id || '—'} ·{' '}
                      {p.lat != null
                        ? `${Number(p.lat).toFixed(4)}, ${Number(p.lng).toFixed(4)}`
                        : 'No GPS'}
                    </div>
                  </div>
                  {p.lat != null && (
                    <a
                      className="ro-btn"
                      href={`https://www.google.com/maps?q=${p.lat},${p.lng}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open map
                    </a>
                  )}
                </div>
              ))}
            </div>
          </>
        )}

        {tab === 'history' && (
          <>
            <h1>History</h1>
            <p className="ro-muted">Your recorded operator actions.</p>
            <div className="ro-card">
              <table className="ro-table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Action</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((h) => (
                    <tr key={h.id}>
                      <td>
                        {h.created_at
                          ? new Date(h.created_at).toLocaleString()
                          : '—'}
                      </td>
                      <td>{h.action}</td>
                      <td>
                        {h.entity_type} {h.entity_id}
                        <div className="ro-muted">{h.detail}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </main>
    </div>
  );
}