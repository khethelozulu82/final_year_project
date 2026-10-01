/**
 * RankFlow Operations Console — admin dashboard.
 *
 * Schedule a trip:
 *   - Required: Route, Departure day, Driver, Vehicle
 *   - Optional: Operator (rank pool when blank), Expected time, Seat
 *     capacity, Notes
 *
 * The Operator and Driver dropdowns are grouped so that accounts tied to the
 * selected route's departure rank and association appear at the top of each
 * list, under the heading "Same rank / association".
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, getUser } from '../api';
import ThemeToggle from '../components/ThemeToggle.jsx';
import '../styles/rankflowAdmin.css';

const NAV = [
  { id: 'overview', label: 'Overview' },
  { id: 'announcements', label: 'Announcements' },
  { id: 'complaints', label: 'Complaints' },
  { id: 'trips', label: 'Trips / Queue' },
  { id: 'accounts', label: 'Accounts' },
  { id: 'drivers', label: 'Drivers' },
  { id: 'safety', label: 'Safety' },
  { id: 'panics', label: 'Panic alerts' },
  { id: 'history', label: 'History' },
  { id: 'dev', label: 'Dev / Simulate' },
];

const emptyAnn = {
  topic: '',
  message: '',
  audience: 'drivers_operators',
  rank_id: '',
  route_id: '',
  service: 'commuter',
  publish: true,
};

const emptyTrip = {
  route_id: '',
  operator_id: '',
  departure_date: '',
  expected_departure_time: '',
  seat_capacity: 15,
  driver_id: '',
  vehicle_id: '',
  notes: '',
};

function fmt(t) {
  if (!t) return '—';
  try {
    return new Date(t).toLocaleString();
  } catch {
    return String(t);
  }
}

function orderByRank(items, predicate) {
  const matched = [];
  const rest = [];
  for (const it of items) {
    (predicate(it) ? matched : rest).push(it);
  }
  return { matched, rest };
}

export default function RankFlowAdminPage({ notify, onExit }) {
  const user = getUser();
  const [tab, setTab] = useState('overview');
  const [busy, setBusy] = useState(false);
  const [overview, setOverview] = useState(null);
  const [anns, setAnns] = useState([]);
  const [annForm, setAnnForm] = useState(emptyAnn);
  const [editAnnId, setEditAnnId] = useState(null);
  const [complaints, setComplaints] = useState([]);
  const [queue, setQueue] = useState([]);
  const [options, setOptions] = useState({
    routes: [],
    operators: [],
    drivers: [],
    vehicles: [],
  });
  const [tripForm, setTripForm] = useState(emptyTrip);
  const [showTripForm, setShowTripForm] = useState(false);
  const [editTripId, setEditTripId] = useState(null);
  const [users, setUsers] = useState([]);
  const [drivers, setDrivers] = useState([]);
  const [safety, setSafety] = useState([]);
  const [panics, setPanics] = useState([]);
  const [history, setHistory] = useState([]);
  const [simTripId, setSimTripId] = useState('');

  const loadOverview = useCallback(async () => {
    try {
      setOverview(await api.adminOverview());
    } catch (e) {
      try {
        setOverview(await api.adminSummary());
      } catch (e2) {
        notify?.(e2.message);
      }
    }
  }, [notify]);

  const loadAnns = useCallback(async () => {
    try {
      setAnns(await api.adminAnnouncements());
    } catch (e) {
      notify?.(e.message);
    }
  }, [notify]);

  const loadComplaints = useCallback(async () => {
    try {
      setComplaints(await api.adminComplaints());
    } catch (e) {
      notify?.(e.message);
    }
  }, [notify]);

  const loadQueue = useCallback(async () => {
    try {
      setQueue(await api.adminTripQueue(''));
      setOptions(await api.adminTripOptions());
    } catch (e) {
      notify?.(e.message);
    }
  }, [notify]);

  const loadUsers = useCallback(async () => {
    try {
      setUsers(await api.adminUsers(''));
    } catch (e) {
      notify?.(e.message);
    }
  }, [notify]);

  const loadDrivers = useCallback(async () => {
    try {
      setDrivers(await api.adminDrivers());
    } catch (e) {
      notify?.(e.message);
    }
  }, [notify]);

  const loadSafety = useCallback(async () => {
    try {
      setSafety(await api.adminSafety());
    } catch (e) {
      notify?.(e.message);
    }
  }, [notify]);

  const loadPanics = useCallback(async () => {
    try {
      setPanics(await api.adminPanicsLive());
    } catch (e) {
      try {
        setPanics(await api.adminPanics());
      } catch (e2) {
        notify?.(e2.message);
      }
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
      overview: loadOverview,
      announcements: loadAnns,
      complaints: loadComplaints,
      trips: loadQueue,
      accounts: loadUsers,
      drivers: loadDrivers,
      safety: loadSafety,
      panics: loadPanics,
      history: loadHistory,
      dev: loadQueue,
    };
    map[tab]?.();
  }, [
    tab,
    loadOverview,
    loadAnns,
    loadComplaints,
    loadQueue,
    loadUsers,
    loadDrivers,
    loadSafety,
    loadPanics,
    loadHistory,
  ]);

  const selectedRoute = (options.routes || []).find(
    (r) => String(r.id) === String(tripForm.route_id)
  );
  const selectedRankId = selectedRoute?.departure_rank_id || null;

  const operatorGroups = useMemo(() => {
    if (!selectedRankId) return { matched: [], rest: options.operators || [] };
    return orderByRank(options.operators || [], (op) =>
      Array.isArray(op.rank_ids) && op.rank_ids.includes(selectedRankId)
    );
  }, [options.operators, selectedRankId]);

  const rankAssociationIds = useMemo(() => {
    const ids = new Set();
    for (const op of operatorGroups.matched) {
      if (op.association_id) ids.add(op.association_id);
    }
    return ids;
  }, [operatorGroups.matched]);

  const driverGroups = useMemo(() => {
    if (rankAssociationIds.size === 0)
      return { matched: [], rest: options.drivers || [] };
    return orderByRank(options.drivers || [], (d) =>
      d.association_id != null && rankAssociationIds.has(d.association_id)
    );
  }, [options.drivers, rankAssociationIds]);

  async function saveAnnouncement(e) {
    e?.preventDefault?.();
    if (!annForm.topic || !annForm.message) {
      notify?.('Topic and message required');
      return;
    }
    setBusy(true);
    try {
      const payload = {
        ...annForm,
        rank_id: annForm.rank_id ? Number(annForm.rank_id) : null,
        route_id: annForm.route_id ? Number(annForm.route_id) : null,
      };
      if (editAnnId) {
        await api.adminUpdateAnnouncement(editAnnId, payload);
        notify?.('Announcement updated');
      } else {
        await api.adminCreateAnnouncement(payload);
        notify?.('Announcement created');
      }
      setAnnForm(emptyAnn);
      setEditAnnId(null);
      await loadAnns();
    } catch (err) {
      notify?.(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function deactivateAnn(id) {
    setBusy(true);
    try {
      await api.adminUpdateAnnouncement(id, { deactivate: true });
      notify?.('Announcement deactivated');
      await loadAnns();
    } catch (e) {
      notify?.(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function reviewComplaint(id, action) {
    setBusy(true);
    try {
      await api.adminReviewComplaint(id, { action });
      notify?.(action === 'refer_safety' ? 'Referred to safety' : 'Complaint updated');
      await loadComplaints();
    } catch (e) {
      notify?.(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function submitTrip(e) {
    e?.preventDefault?.();

    if (!tripForm.route_id) {
      notify?.('Route is required.');
      return;
    }
    if (!tripForm.departure_date) {
      notify?.('Departure day is required.');
      return;
    }
    if (!tripForm.driver_id) {
      notify?.('Driver is required.');
      return;
    }
    if (!tripForm.vehicle_id) {
      notify?.('Vehicle is required.');
      return;
    }

    setBusy(true);
    const payload = {
      route_id: Number(tripForm.route_id),
      departure_date: tripForm.departure_date,
      expected_departure_time: tripForm.expected_departure_time || null,
      seat_capacity: Number(tripForm.seat_capacity) || 15,
      notes: tripForm.notes || '',
      driver_id: Number(tripForm.driver_id),
      vehicle_id: Number(tripForm.vehicle_id),
    };
    if (tripForm.operator_id) payload.operator_id = Number(tripForm.operator_id);

    try {
      if (editTripId) {
        await api.adminUpdateTrip(editTripId, payload);
        notify?.('Trip updated');
      } else {
        const t = await api.adminScheduleTrip(payload);
        notify?.(
          t.operator_id
            ? `Trip ${t.trip_code} created (assigned)`
            : `Trip ${t.trip_code} created — unassigned, any rank operator can confirm`
        );
      }
      setShowTripForm(false);
      setEditTripId(null);
      setTripForm(emptyTrip);
      await loadQueue();
    } catch (err) {
      notify?.(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function cancelTrip(t) {
    const reason = window.prompt(
      `Reason for cancelling ${t.trip_code}?\n\nThis will cancel all bookings on the trip and notify passengers + driver.`
    );
    if (reason === null) return;
    setBusy(true);
    try {
      const res = await api.cancelTrip(t.id, reason || '');
      notify?.(res?.message || `${t.trip_code} cancelled — bookings cleared.`);
      await loadQueue();
    } catch (e) {
      notify?.(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function deleteTrip(t) {
    if (!t.can_delete) return;
    if (!window.confirm(`Delete ${t.trip_code}?`)) return;
    setBusy(true);
    try {
      await api.adminDeleteTrip(t.id);
      notify?.('Trip deleted');
      await loadQueue();
    } catch (e) {
      notify?.(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function toggleUser(u) {
    setBusy(true);
    try {
      await api.adminSetUserActive(u.id, !u.is_active);
      notify?.(u.is_active ? 'Disabled' : 'Approved / activated');
      await loadUsers();
    } catch (e) {
      notify?.(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function verifyDriver(id, decision) {
    setBusy(true);
    try {
      await api.adminDriverVerify(id, decision);
      notify?.(decision === 'verify' ? 'Driver approved' : 'Driver rejected');
      await loadDrivers();
    } catch (e) {
      notify?.(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function safetyDecide(id, decision) {
    setBusy(true);
    try {
      await api.adminSafetyDecide(id, { decision });
      notify?.(`Safety: ${decision}`);
      await loadSafety();
    } catch (e) {
      notify?.(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function simulate(step) {
    if (!simTripId) {
      notify?.('Enter a trip id');
      return;
    }
    setBusy(true);
    try {
      const t = await api.adminSimulateTrip(Number(simTripId), step);
      notify?.(`Simulated → ${t.status}`);
      await loadQueue();
    } catch (e) {
      notify?.(e.message);
    } finally {
      setBusy(false);
    }
  }

  const name =
    [user?.first_name, user?.last_name].filter(Boolean).join(' ') ||
    user?.username ||
    'Admin';

  return (
    <div className="rf-shell">
      <aside className="rf-nav">
        <div className="rf-brand">
          <span className="rf-brand-mark" />
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
          </button>
        ))}
        <div className="rf-nav-foot">
          {name}
          <br />
          Regional administrator
          {typeof onExit === 'function' && (
            <button
              type="button"
              className="rf-btn ghost"
              style={{ marginTop: 12, width: '100%' }}
              onClick={onExit}
            >
              Sign out
            </button>
          )}
        </div>
      </aside>

      <main className="rf-main">
        <div className="rf-top">
          <div>
            <p className="rf-muted">{new Date().toDateString()}</p>
            <h1>
              {tab === 'overview' && 'Operations overview'}
              {tab === 'announcements' && 'Announcements'}
              {tab === 'complaints' && 'Complaint review'}
              {tab === 'trips' && 'Trips & queue'}
              {tab === 'accounts' && 'Account management'}
              {tab === 'drivers' && 'Driver information'}
              {tab === 'safety' && 'Safety incidents'}
              {tab === 'panics' && 'Panic alerts'}
              {tab === 'history' && 'System history'}
              {tab === 'dev' && 'DEV · Trip simulation'}
            </h1>
          </div>
          <ThemeToggle />
        </div>

        {tab === 'overview' && (
          <>
            <div className="rf-stats">
              {[
                ['Active trips', overview?.active_trips ?? overview?.trips],
                ['Rank queue', overview?.rank_queue],
                ['Escalations', overview?.escalations ?? overview?.open_flags],
                [
                  'Pending accounts',
                  overview?.pending_accounts ?? overview?.drivers_pending,
                ],
                ['Live announcements', overview?.announcements_live],
                ['Panic alerts', overview?.open_panics ?? overview?.panic_alerts],
              ].map(([l, v]) => (
                <div className="rf-stat" key={l}>
                  <span>{l}</span>
                  <strong>{v ?? '—'}</strong>
                </div>
              ))}
            </div>
            <div className="rf-card">
              <div className="rf-toolbar">
                <h3>Quick actions</h3>
              </div>
              <div className="rf-actions">
                <button
                  type="button"
                  className="rf-btn primary"
                  onClick={() => setTab('announcements')}
                >
                  Create announcement
                </button>
                <button
                  type="button"
                  className="rf-btn"
                  onClick={() => {
                    setTab('trips');
                    setShowTripForm(true);
                  }}
                >
                  Create trip
                </button>
                <button
                  type="button"
                  className="rf-btn"
                  onClick={() => setTab('trips')}
                >
                  Manage queue
                </button>
                <button
                  type="button"
                  className="rf-btn danger"
                  onClick={() => setTab('panics')}
                >
                  Panic alerts
                </button>
              </div>
            </div>
          </>
        )}

        {tab === 'announcements' && (
          <>
            <div className="rf-card">
              <h3>{editAnnId ? 'Edit announcement' : 'Create announcement'}</h3>
              <p className="rf-muted">
                Scoped by rank / route / audience. Empangeni rank reaches operators &
                drivers linked to that rank.
              </p>
              <form className="rf-form" onSubmit={saveAnnouncement}>
                <label>
                  Topic *
                  <input
                    value={annForm.topic}
                    onChange={(e) =>
                      setAnnForm({ ...annForm, topic: e.target.value })
                    }
                    required
                  />
                </label>
                <label>
                  Audience
                  <select
                    value={annForm.audience}
                    onChange={(e) =>
                      setAnnForm({ ...annForm, audience: e.target.value })
                    }
                  >
                    <option value="drivers_operators">Drivers + operators</option>
                    <option value="drivers">Drivers only</option>
                    <option value="operators">Operators only</option>
                    <option value="all_users">Every user</option>
                  </select>
                </label>
                <label className="rf-span">
                  Message *
                  <textarea
                    value={annForm.message}
                    onChange={(e) =>
                      setAnnForm({ ...annForm, message: e.target.value })
                    }
                    required
                    maxLength={500}
                  />
                </label>
                <label>
                  Rank id (optional)
                  <input
                    value={annForm.rank_id}
                    onChange={(e) =>
                      setAnnForm({ ...annForm, rank_id: e.target.value })
                    }
                    placeholder="e.g. 1"
                  />
                </label>
                <label>
                  Route id (optional)
                  <input
                    value={annForm.route_id}
                    onChange={(e) =>
                      setAnnForm({ ...annForm, route_id: e.target.value })
                    }
                  />
                </label>
                <label>
                  Publish now
                  <select
                    value={annForm.publish ? '1' : '0'}
                    onChange={(e) =>
                      setAnnForm({ ...annForm, publish: e.target.value === '1' })
                    }
                  >
                    <option value="1">Yes — notify recipients</option>
                    <option value="0">Save draft only</option>
                  </select>
                </label>
                <div className="rf-actions">
                  <button
                    type="submit"
                    className="rf-btn primary"
                    disabled={busy}
                  >
                    {editAnnId ? 'Save update' : 'Publish / save'}
                  </button>
                  {editAnnId && (
                    <button
                      type="button"
                      className="rf-btn ghost"
                      onClick={() => {
                        setEditAnnId(null);
                        setAnnForm(emptyAnn);
                      }}
                    >
                      Cancel edit
                    </button>
                  )}
                </div>
              </form>
            </div>
            <div className="rf-card">
              <div className="rf-toolbar">
                <h3>All announcements</h3>
                <button type="button" className="rf-btn ghost" onClick={loadAnns}>
                  Refresh
                </button>
              </div>
              <table className="rf-table">
                <thead>
                  <tr>
                    <th>Topic</th>
                    <th>Status</th>
                    <th>Audience</th>
                    <th>Reach</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {anns.map((a) => (
                    <tr key={a.id}>
                      <td>
                        <strong>{a.topic}</strong>
                        <small>{a.message?.slice(0, 80)}</small>
                      </td>
                      <td>
                        <span className="rf-pill">{a.status}</span>
                      </td>
                      <td>{a.audience}</td>
                      <td>{a.reach_count}</td>
                      <td className="rf-actions">
                        <button
                          type="button"
                          className="rf-btn ghost"
                          onClick={() => {
                            setEditAnnId(a.id);
                            setAnnForm({
                              topic: a.topic,
                              message: a.message,
                              audience: a.audience,
                              rank_id: a.rank_id || '',
                              route_id: a.route_id || '',
                              service: a.service || 'commuter',
                              publish: false,
                            });
                          }}
                        >
                          Edit
                        </button>
                        {a.status !== 'inactive' && (
                          <button
                            type="button"
                            className="rf-btn danger"
                            onClick={() => deactivateAnn(a.id)}
                          >
                            Deactivate
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {tab === 'complaints' && (
          <div className="rf-card">
            <p className="rf-muted">
              Escalated complaints first. Admin reviews feedback — safety confirmation is
              only on the Safety tab (not here).
            </p>
            <table className="rf-table">
              <thead>
                <tr>
                  <th>Complaint</th>
                  <th>Driver / trip</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {complaints.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <strong>{c.category}</strong>
                      <small>{c.description?.slice(0, 100)}</small>
                      {c.escalation_reason && (
                        <small>Escalation: {c.escalation_reason}</small>
                      )}
                    </td>
                    <td>
                      {c.driver_name}
                      <small>{c.trip_code || c.trip_id || '—'}</small>
                    </td>
                    <td>
                      <span className="rf-pill">{c.status}</span>
                    </td>
                    <td className="rf-actions">
                      <button
                        type="button"
                        className="rf-btn"
                        disabled={busy}
                        onClick={() => reviewComplaint(c.id, 'reviewed')}
                      >
                        Mark reviewed
                      </button>
                      <button
                        type="button"
                        className="rf-btn danger"
                        disabled={busy}
                        onClick={() => reviewComplaint(c.id, 'refer_safety')}
                      >
                        Refer to safety
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {tab === 'trips' && (
          <>
            <div className="rf-toolbar">
              <button
                type="button"
                className="rf-btn primary"
                onClick={() => {
                  setEditTripId(null);
                  setTripForm({
                    ...emptyTrip,
                    route_id: options.routes[0]?.id || '',
                    driver_id: options.drivers[0]?.id || '',
                    vehicle_id: options.vehicles[0]?.id || '',
                  });
                  setShowTripForm(true);
                }}
              >
                Create trip
              </button>
              <button type="button" className="rf-btn ghost" onClick={loadQueue}>
                Refresh queue
              </button>
            </div>
            {showTripForm && (
              <div className="rf-card">
                <h3>{editTripId ? 'Edit trip' : 'Create trip'}</h3>
                <p className="rf-muted">
                  Fill in the <strong>required</strong> fields to schedule a trip.
                  A verified driver and a vehicle must be assigned to every trip.
                </p>
                <form className="rf-form" onSubmit={submitTrip}>
                  <div className="rf-form-section-label">
                    Required <span className="rf-required-mark">*</span>
                  </div>

                  <label>
                    Route <span className="rf-required-mark">*</span>
                    <select
                      required
                      value={tripForm.route_id}
                      onChange={(e) =>
                        setTripForm({ ...tripForm, route_id: e.target.value })
                      }
                    >
                      <option value="">Select route</option>
                      {(options.routes || []).map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.label}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label>
                    Departure day <span className="rf-required-mark">*</span>
                    <input
                      type="date"
                      required
                      value={tripForm.departure_date}
                      onChange={(e) =>
                        setTripForm({
                          ...tripForm,
                          departure_date: e.target.value,
                        })
                      }
                    />
                  </label>

                  <label>
                    Driver <span className="rf-required-mark">*</span>
                    <select
                      required
                      value={tripForm.driver_id}
                      onChange={(e) =>
                        setTripForm({
                          ...tripForm,
                          driver_id: e.target.value,
                        })
                      }
                    >
                      <option value="">Select driver</option>
                      {driverGroups.matched.length > 0 && (
                        <optgroup label="Same rank / association">
                          {driverGroups.matched.map((d) => (
                            <option key={d.id} value={d.id}>
                              {d.label}
                            </option>
                          ))}
                        </optgroup>
                      )}
                      {driverGroups.rest.length > 0 && (
                        <optgroup label="Other verified drivers">
                          {driverGroups.rest.map((d) => (
                            <option key={d.id} value={d.id}>
                              {d.label}
                            </option>
                          ))}
                        </optgroup>
                      )}
                    </select>
                  </label>

                  <label>
                    Vehicle <span className="rf-required-mark">*</span>
                    <select
                      required
                      value={tripForm.vehicle_id}
                      onChange={(e) =>
                        setTripForm({
                          ...tripForm,
                          vehicle_id: e.target.value,
                        })
                      }
                    >
                      <option value="">Select vehicle</option>
                      {(options.vehicles || []).map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.label}
                        </option>
                      ))}
                    </select>
                  </label>

                  <div className="rf-form-section-label rf-span">
                    Optional
                    <span className="rf-form-section-hint">
                      Leave blank to allow any operator whose active rank matches
                      the route
                    </span>
                  </div>

                  <label>
                    Operator
                    <select
                      value={tripForm.operator_id}
                      onChange={(e) =>
                        setTripForm({
                          ...tripForm,
                          operator_id: e.target.value,
                        })
                      }
                    >
                      <option value="">
                        — Rank pool (any rank operator) —
                      </option>
                      {operatorGroups.matched.length > 0 && (
                        <optgroup label="Same rank / association">
                          {operatorGroups.matched.map((o) => (
                            <option key={o.id} value={o.id}>
                              {o.label}
                            </option>
                          ))}
                        </optgroup>
                      )}
                      {operatorGroups.rest.length > 0 && (
                        <optgroup label="Other operators">
                          {operatorGroups.rest.map((o) => (
                            <option key={o.id} value={o.id}>
                              {o.label}
                            </option>
                          ))}
                        </optgroup>
                      )}
                    </select>
                  </label>

                  <label>
                    Expected time
                    <input
                      type="time"
                      value={tripForm.expected_departure_time}
                      onChange={(e) =>
                        setTripForm({
                          ...tripForm,
                          expected_departure_time: e.target.value,
                        })
                      }
                    />
                  </label>

                  <label>
                    Seat capacity
                    <input
                      type="number"
                      min={1}
                      max={30}
                      value={tripForm.seat_capacity}
                      onChange={(e) =>
                        setTripForm({
                          ...tripForm,
                          seat_capacity: e.target.value,
                        })
                      }
                      placeholder="15"
                    />
                  </label>

                  <label className="rf-span">
                    Notes
                    <input
                      type="text"
                      value={tripForm.notes}
                      onChange={(e) =>
                        setTripForm({ ...tripForm, notes: e.target.value })
                      }
                      placeholder="e.g. Saturday special — extra luggage space needed"
                    />
                  </label>

                  <div className="rf-actions rf-span">
                    <button
                      type="submit"
                      className="rf-btn primary"
                      disabled={busy}
                    >
                      {editTripId ? 'Save changes' : 'Create trip'}
                    </button>
                    <button
                      type="button"
                      className="rf-btn ghost"
                      onClick={() => {
                        setShowTripForm(false);
                        setEditTripId(null);
                        setTripForm(emptyTrip);
                      }}
                    >
                      Close
                    </button>
                  </div>
                </form>
              </div>
            )}
            <div className="rf-card">
              <h3>Queue (created trips)</h3>
              <table className="rf-table">
                <thead>
                  <tr>
                    <th>Trip</th>
                    <th>Route / day</th>
                    <th>Operator</th>
                    <th>Driver / vehicle</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {queue.map((t) => (
                    <tr key={t.id}>
                      <td>
                        <strong>{t.trip_code}</strong>
                        <small>id {t.id}</small>
                      </td>
                      <td>
                        {t.route_label}
                        <small>
                          {t.departure_date}{' '}
                          {String(t.expected_departure_time || '').slice(0, 5)}
                        </small>
                      </td>
                      <td>
                        {t.operator_name || (
                          <span className="rf-pill">RANK POOL</span>
                        )}
                      </td>
                      <td>
                        {t.driver_name || '—'}
                        <small>{t.vehicle_plate}</small>
                      </td>
                      <td>
                        <span className="rf-pill">{t.status}</span>
                        <small>
                          {t.seats_taken}/{t.seat_capacity} seats
                        </small>
                      </td>
                      <td className="rf-actions">
                        <button
                          type="button"
                          className="rf-btn ghost"
                          onClick={() => {
                            setEditTripId(t.id);
                            setTripForm({
                              route_id: t.route_id || '',
                              operator_id: t.operator_id || '',
                              departure_date: String(
                                t.departure_date || ''
                              ).slice(0, 10),
                              expected_departure_time: String(
                                t.expected_departure_time || ''
                              ).slice(0, 5),
                              seat_capacity: t.seat_capacity || 15,
                              driver_id: t.driver_id || '',
                              vehicle_id: t.vehicle_id || '',
                              notes: t.notes || '',
                            });
                            setShowTripForm(true);
                          }}
                        >
                          Edit
                        </button>
                        {t.status !== 'cancelled' && t.status !== 'completed' && (
                          <button
                            type="button"
                            className="rf-btn danger"
                            onClick={() => cancelTrip(t)}
                          >
                            Cancel
                          </button>
                        )}
                        {t.can_delete && (
                          <button
                            type="button"
                            className="rf-btn danger"
                            onClick={() => deleteTrip(t)}
                          >
                            Delete
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {tab === 'accounts' && (
          <div className="rf-card">
            <table className="rf-table">
              <thead>
                <tr>
                  <th>User</th>
                  <th>Role</th>
                  <th>Active</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td>
                      {u.first_name} {u.last_name}
                      <small>{u.phone || u.email || u.username}</small>
                    </td>
                    <td>
                      <span className="rf-pill">{u.role}</span>
                    </td>
                    <td>{u.is_active ? 'Yes' : 'Pending / disabled'}</td>
                    <td className="rf-actions">
                      <button
                        type="button"
                        className="rf-btn primary"
                        disabled={busy}
                        onClick={() => toggleUser({ ...u, is_active: false })}
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        className="rf-btn danger"
                        disabled={busy}
                        onClick={() => toggleUser({ ...u, is_active: true })}
                      >
                        Disable
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {tab === 'drivers' && (
          <div className="rf-card">
            <table className="rf-table">
              <thead>
                <tr>
                  <th>Driver</th>
                  <th>Licence</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {drivers.map((d) => (
                  <tr key={d.id}>
                    <td>
                      {d.name}
                      <small>{d.phone}</small>
                    </td>
                    <td>{d.license_number}</td>
                    <td>
                      <span className="rf-pill">{d.status}</span>
                    </td>
                    <td className="rf-actions">
                      {d.status === 'pending' && (
                        <>
                          <button
                            type="button"
                            className="rf-btn primary"
                            onClick={() => verifyDriver(d.id, 'verify')}
                          >
                            Approve
                          </button>
                          <button
                            type="button"
                            className="rf-btn danger"
                            onClick={() => verifyDriver(d.id, 'reject')}
                          >
                            Reject
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {tab === 'safety' && (
          <div className="rf-card">
            <p className="rf-muted">
              Only this panel confirms a safety incident. Complaint review cannot
              classify safety alone.
            </p>
            <table className="rf-table">
              <thead>
                <tr>
                  <th>Incident</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {safety.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <strong>{s.title}</strong>
                      <small>
                        {s.source} · trip {s.trip_id || '—'}
                      </small>
                    </td>
                    <td>
                      <span className="rf-pill">{s.status}</span>
                    </td>
                    <td className="rf-actions">
                      <button
                        type="button"
                        className="rf-btn danger"
                        onClick={() => safetyDecide(s.id, 'confirm')}
                      >
                        Confirm safety incident
                      </button>
                      <button
                        type="button"
                        className="rf-btn ghost"
                        onClick={() => safetyDecide(s.id, 'not_safety')}
                      >
                        Not a safety incident
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {tab === 'panics' && (
          <div className="rf-card rf-panic">
            <h3>Live panic alerts</h3>
            <p className="rf-muted">
              Passenger panic sends alert with live GPS. Open coordinates in maps for
              routing to user.
            </p>
            <table className="rf-table">
              <thead>
                <tr>
                  <th>User</th>
                  <th>Trip</th>
                  <th>Live location</th>
                  <th>When</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {panics.map((p) => (
                  <tr key={p.id}>
                    <td>{p.user_name || p.user || '—'}</td>
                    <td>{p.trip_code || p.trip_id || '—'}</td>
                    <td>
                      {p.lat != null ? (
                        <>
                          {Number(p.lat).toFixed(5)}, {Number(p.lng).toFixed(5)}
                          <small>accuracy {p.accuracy_m ?? '—'} m</small>
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>{fmt(p.created_at)}</td>
                    <td>
                      {p.lat != null && (
                        <a
                          className="rf-btn"
                          href={`https://www.google.com/maps?q=${p.lat},${p.lng}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Open map / route
                        </a>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {tab === 'history' && (
          <div className="rf-card">
            <p className="rf-muted">Audit of system actions (admin sees all).</p>
            <table className="rf-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Actor</th>
                  <th>Action</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.id}>
                    <td>{fmt(h.created_at)}</td>
                    <td>{h.actor || '—'}</td>
                    <td>{h.action}</td>
                    <td>
                      {h.entity_type} {h.entity_id}
                      <small>{h.detail}</small>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {tab === 'dev' && (
          <div className="rf-card rf-dev">
            <h3>Simulate trip progression (testing only)</h3>
            <p className="rf-muted">
              Advances scheduled → boarding → in_progress → completed and notifies
              driver / passengers. Use real trip id from the queue.
            </p>
            <div className="rf-form">
              <label>
                Trip id
                <input
                  value={simTripId}
                  onChange={(e) => setSimTripId(e.target.value)}
                  placeholder="e.g. 1"
                />
              </label>
            </div>
            <div className="rf-actions" style={{ marginTop: 12 }}>
              <button
                type="button"
                className="rf-btn primary"
                disabled={busy}
                onClick={() => simulate('next')}
              >
                Next status
              </button>
              <button
                type="button"
                className="rf-btn"
                disabled={busy}
                onClick={() => simulate('reset')}
              >
                Reset scheduled
              </button>
              <button
                type="button"
                className="rf-btn danger"
                disabled={busy}
                onClick={() => simulate('cancel')}
              >
                Force cancel
              </button>
            </div>
            <table className="rf-table" style={{ marginTop: 16 }}>
              <thead>
                <tr>
                  <th>Id</th>
                  <th>Code</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {queue.slice(0, 12).map((t) => (
                  <tr key={t.id}>
                    <td>
                      <button
                        type="button"
                        className="rf-btn ghost"
                        onClick={() => setSimTripId(String(t.id))}
                      >
                        {t.id}
                      </button>
                    </td>
                    <td>{t.trip_code}</td>
                    <td>
                      <span className="rf-pill">{t.status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  );
}