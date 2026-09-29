/**
 * Admin console — legacy FYP admin (overview, users, drivers, memberships,
 * flags, panics, and Schedule a trip + trip queue).
 *
 * Note: RankFlowAdminPage.jsx is the primary admin console. This page remains
 * for backwards compatibility and as a secondary entry point.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import '../styles/adminConsole.css';

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'trips', label: 'Trip queue' },
  { id: 'users', label: 'Users' },
  { id: 'drivers', label: 'Drivers' },
  { id: 'memberships', label: 'Rank memberships' },
  { id: 'flags', label: 'Trip flags' },
  { id: 'panics', label: 'Panic alerts' },
];

const emptyForm = {
  route_id: '',
  operator_id: '',
  departure_date: '',
  expected_departure_time: '',
  seat_capacity: 15,
  driver_id: '',
  vehicle_id: '',
  notes: '',
  status: 'scheduled',
};

function fmtTime(t) {
  if (!t) return '—';
  const s = String(t);
  return s.length >= 5 ? s.slice(0, 5) : s;
}

export default function AdminPage({ notify }) {
  const [tab, setTab] = useState('trips');
  const [summary, setSummary] = useState(null);
  const [users, setUsers] = useState([]);
  const [drivers, setDrivers] = useState([]);
  const [memberships, setMemberships] = useState([]);
  const [flags, setFlags] = useState([]);
  const [panics, setPanics] = useState([]);
  const [roleFilter, setRoleFilter] = useState('');
  const [busy, setBusy] = useState(false);

  const [queue, setQueue] = useState([]);
  const [queueStatus, setQueueStatus] = useState('');
  const [options, setOptions] = useState({
    routes: [],
    operators: [],
    drivers: [],
    vehicles: [],
  });
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(emptyForm);

  const loadSummary = useCallback(async () => {
    try {
      setSummary(await api.adminSummary());
    } catch (e) {
      notify?.(e.message || 'Could not load summary');
    }
  }, [notify]);

  const loadUsers = useCallback(async () => {
    try {
      setUsers(await api.adminUsers(roleFilter));
    } catch (e) {
      notify?.(e.message || 'Could not load users');
    }
  }, [notify, roleFilter]);

  const loadDrivers = useCallback(async () => {
    try {
      setDrivers(await api.adminDrivers());
    } catch (e) {
      notify?.(e.message || 'Could not load drivers');
    }
  }, [notify]);

  const loadMemberships = useCallback(async () => {
    try {
      setMemberships(await api.adminMemberships('pending'));
    } catch (e) {
      notify?.(e.message || 'Could not load memberships');
    }
  }, [notify]);

  const loadFlags = useCallback(async () => {
    try {
      setFlags(await api.adminFlags());
    } catch (e) {
      notify?.(e.message || 'Could not load flags');
    }
  }, [notify]);

  const loadPanics = useCallback(async () => {
    try {
      setPanics(await api.adminPanics());
    } catch (e) {
      notify?.(e.message || 'Could not load panics');
    }
  }, [notify]);

  const loadQueue = useCallback(async () => {
    try {
      setQueue(await api.adminTripQueue(queueStatus));
    } catch (e) {
      notify?.(e.message || 'Could not load trip queue');
    }
  }, [notify, queueStatus]);

  const loadOptions = useCallback(async () => {
    try {
      setOptions(await api.adminTripOptions());
    } catch (e) {
      notify?.(e.message || 'Could not load schedule options');
    }
  }, [notify]);

  useEffect(() => {
    loadSummary();
  }, [loadSummary]);

  useEffect(() => {
    if (tab === 'users') loadUsers();
    if (tab === 'drivers') loadDrivers();
    if (tab === 'memberships') loadMemberships();
    if (tab === 'flags') loadFlags();
    if (tab === 'panics') loadPanics();
    if (tab === 'overview') loadSummary();
    if (tab === 'trips') {
      loadQueue();
      loadOptions();
    }
  }, [
    tab,
    loadUsers,
    loadDrivers,
    loadMemberships,
    loadFlags,
    loadPanics,
    loadSummary,
    loadQueue,
    loadOptions,
  ]);

  function openSchedule() {
    setEditingId(null);
    setForm({
      ...emptyForm,
      route_id: options.routes[0]?.id ? String(options.routes[0].id) : '',
      operator_id: options.operators[0]?.id ? String(options.operators[0].id) : '',
      driver_id: options.drivers[0]?.id ? String(options.drivers[0].id) : '',
      vehicle_id: options.vehicles[0]?.id ? String(options.vehicles[0].id) : '',
      seat_capacity: 15,
    });
    setShowForm(true);
  }

  function openEdit(t) {
    setEditingId(t.id);
    setForm({
      route_id: t.route_id != null ? String(t.route_id) : '',
      operator_id: t.operator_id != null ? String(t.operator_id) : '',
      departure_date: t.departure_date
        ? String(t.departure_date).slice(0, 10)
        : '',
      expected_departure_time: t.expected_departure_time
        ? fmtTime(t.expected_departure_time)
        : '',
      seat_capacity: t.seat_capacity || 15,
      driver_id: t.driver_id != null ? String(t.driver_id) : '',
      vehicle_id: t.vehicle_id != null ? String(t.vehicle_id) : '',
      notes: t.notes || '',
      status: t.status || 'scheduled',
    });
    setShowForm(true);
  }

  function setField(key, value) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function submitSchedule(e) {
    e?.preventDefault?.();
    if (!form.route_id || !form.departure_date) {
      notify?.('Route and departure date are required.');
      return;
    }
    setBusy(true);
    const payload = {
      route_id: Number(form.route_id),
      departure_date: form.departure_date,
      expected_departure_time: form.expected_departure_time || null,
      seat_capacity: Number(form.seat_capacity) || 15,
      notes: form.notes || '',
    };
    if (form.operator_id) payload.operator_id = Number(form.operator_id);
    if (form.driver_id) payload.driver_id = Number(form.driver_id);
    if (form.vehicle_id) payload.vehicle_id = Number(form.vehicle_id);

    try {
      if (editingId) {
        await api.adminUpdateTrip(editingId, {
          ...payload,
          status: form.status,
        });
        notify?.('Trip updated.');
      } else {
        await api.adminScheduleTrip(payload);
        notify?.('Trip scheduled — added to queue.');
      }
      setShowForm(false);
      setEditingId(null);
      await loadQueue();
      await loadSummary();
    } catch (err) {
      notify?.(err.message || 'Could not save trip.');
    } finally {
      setBusy(false);
    }
  }

  async function deleteTrip(t) {
    if (!t.can_delete) {
      notify?.('This trip cannot be deleted (has passengers or is active).');
      return;
    }
    if (!window.confirm(`Delete trip ${t.trip_code}? This cannot be undone.`)) return;
    setBusy(true);
    try {
      await api.adminDeleteTrip(t.id);
      notify?.(`Deleted ${t.trip_code}.`);
      await loadQueue();
      await loadSummary();
    } catch (err) {
      notify?.(err.message || 'Could not delete trip.');
    } finally {
      setBusy(false);
    }
  }

  async function cancelTrip(t) {
    setBusy(true);
    try {
      await api.adminUpdateTrip(t.id, { status: 'cancelled' });
      notify?.(`${t.trip_code} marked cancelled.`);
      await loadQueue();
    } catch (err) {
      notify?.(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(u) {
    setBusy(true);
    try {
      await api.adminSetUserActive(u.id, !u.is_active);
      notify?.(u.is_active ? 'User deactivated' : 'User activated');
      await loadUsers();
      await loadSummary();
    } catch (e) {
      notify?.(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function decideMembership(id, decision) {
    setBusy(true);
    try {
      await api.adminMembershipDecide(id, decision);
      notify?.(decision === 'approve' ? 'Membership approved' : 'Membership rejected');
      await loadMemberships();
      await loadSummary();
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
      notify?.(decision === 'verify' ? 'Driver verified' : 'Driver rejected');
      await loadDrivers();
      await loadSummary();
    } catch (e) {
      notify?.(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="adm-shell">
      <header className="adm-header">
        <div>
          <p className="adm-kicker">SYSTEM ADMINISTRATION</p>
          <h1>Admin panel</h1>
          <p className="adm-hint">
            Schedule trips, manage the queue, users, drivers, ranks, flags, and alerts.
          </p>
        </div>
      </header>

      <nav className="adm-tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={tab === t.id ? 'adm-tab active' : 'adm-tab'}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {tab === 'trips' && (
        <section className="adm-card">
          <div className="adm-toolbar">
            <h3>Trip queue</h3>
            <select
              value={queueStatus}
              onChange={(e) => setQueueStatus(e.target.value)}
            >
              <option value="">All statuses</option>
              <option value="scheduled">Scheduled</option>
              <option value="boarding">Boarding</option>
              <option value="in_progress">In progress</option>
              <option value="completed">Completed</option>
              <option value="cancelled">Cancelled</option>
              <option value="flagged">Flagged</option>
            </select>
            <button type="button" className="adm-btn ghost" onClick={loadQueue}>
              Refresh
            </button>
            <button type="button" className="adm-btn primary" onClick={openSchedule}>
              Schedule a trip
            </button>
          </div>
          <p className="adm-hint">
            Trips ordered by departure time. Edit scheduled trips; delete unsuccessful ones
            with no passengers.
          </p>
          <table className="adm-table">
            <thead>
              <tr>
                <th>Code</th>
                <th>Route</th>
                <th>Date / time</th>
                <th>Seats</th>
                <th>Driver / vehicle</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {queue.length === 0 && (
                <tr>
                  <td colSpan={7} className="adm-hint">
                    No trips in queue. Use Schedule a trip to add one.
                  </td>
                </tr>
              )}
              {queue.map((t) => (
                <tr key={t.id}>
                  <td>
                    <strong>{t.trip_code}</strong>
                    <small>{t.operator_name || 'Rank pool'}</small>
                  </td>
                  <td>{t.route_label}</td>
                  <td>
                    {t.departure_date}
                    <small>{fmtTime(t.expected_departure_time)}</small>
                  </td>
                  <td>
                    {t.seats_taken}/{t.seat_capacity}
                  </td>
                  <td>
                    {t.driver_name || '—'}
                    <small>{t.vehicle_plate || ''}</small>
                  </td>
                  <td>
                    <span className={`adm-pill status-${t.status}`}>{t.status}</span>
                  </td>
                  <td className="adm-actions">
                    {t.can_edit && (
                      <button
                        type="button"
                        className="adm-btn ghost"
                        disabled={busy}
                        onClick={() => openEdit(t)}
                      >
                        Edit
                      </button>
                    )}
                    {t.status === 'scheduled' && (
                      <button
                        type="button"
                        className="adm-btn ghost"
                        disabled={busy}
                        onClick={() => cancelTrip(t)}
                      >
                        Cancel
                      </button>
                    )}
                    {t.can_delete && (
                      <button
                        type="button"
                        className="adm-btn danger"
                        disabled={busy}
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

          {showForm && (
            <div className="adm-modal-backdrop" role="presentation">
              <form
                className="adm-modal adm-schedule"
                onSubmit={submitSchedule}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="adm-schedule-head">
                  <div>
                    <h3>{editingId ? 'Edit trip' : 'Schedule a trip'}</h3>
                    <p className="adm-hint">
                      {editingId
                        ? 'Update departure details for this queued trip.'
                        : 'Add a new departure. Trips appear in the queue ordered by time.'}
                    </p>
                  </div>
                  <span className="adm-hint">
                    {editingId ? 'Editing' : 'Adds to queue'}
                  </span>
                </div>

                <div className="adm-form-grid">
                  <label>
                    Route
                    <select
                      required
                      value={form.route_id}
                      onChange={(e) => setField('route_id', e.target.value)}
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
                    Operator (optional)
                    <select
                      value={form.operator_id}
                      onChange={(e) => setField('operator_id', e.target.value)}
                    >
                      <option value="">— Rank pool —</option>
                      {(options.operators || []).map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Departure date
                    <input
                      type="date"
                      required
                      value={form.departure_date}
                      onChange={(e) => setField('departure_date', e.target.value)}
                    />
                  </label>
                  <label>
                    Expected time (optional)
                    <input
                      type="time"
                      value={form.expected_departure_time}
                      onChange={(e) =>
                        setField('expected_departure_time', e.target.value)
                      }
                    />
                  </label>
                  <label>
                    Seat capacity
                    <input
                      type="number"
                      min={1}
                      max={30}
                      value={form.seat_capacity}
                      onChange={(e) => setField('seat_capacity', e.target.value)}
                    />
                  </label>
                  <label>
                    Driver (optional)
                    <select
                      value={form.driver_id}
                      onChange={(e) => setField('driver_id', e.target.value)}
                    >
                      <option value="">None</option>
                      {(options.drivers || []).map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="adm-span-2">
                    Vehicle (optional)
                    <select
                      value={form.vehicle_id}
                      onChange={(e) => setField('vehicle_id', e.target.value)}
                    >
                      <option value="">None</option>
                      {(options.vehicles || []).map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  {editingId && (
                    <label>
                      Status
                      <select
                        value={form.status}
                        onChange={(e) => setField('status', e.target.value)}
                      >
                        <option value="scheduled">Scheduled</option>
                        <option value="boarding">Boarding</option>
                        <option value="cancelled">Cancelled</option>
                        <option value="flagged">Flagged</option>
                      </select>
                    </label>
                  )}
                  <label className="adm-span-2">
                    Notes
                    <input
                      type="text"
                      placeholder="e.g. Saturday special"
                      value={form.notes}
                      onChange={(e) => setField('notes', e.target.value)}
                    />
                  </label>
                </div>

                <div className="adm-modal-actions">
                  <button
                    type="button"
                    className="adm-btn ghost"
                    onClick={() => {
                      setShowForm(false);
                      setEditingId(null);
                    }}
                  >
                    Cancel
                  </button>
                  <button type="submit" className="adm-btn primary" disabled={busy}>
                    {busy
                      ? 'Saving…'
                      : editingId
                        ? 'Save changes'
                        : 'Schedule trip'}
                  </button>
                </div>
              </form>
            </div>
          )}
        </section>
      )}

      {tab === 'overview' && (
        <section className="adm-grid">
          {[
            ['Users', summary?.users],
            ['Passengers', summary?.passengers],
            ['Drivers', summary?.drivers],
            ['Operators', summary?.operators],
            ['Trips', summary?.trips],
            ['Flagged trips', summary?.trips_flagged],
            ['Bookings', summary?.bookings],
            ['Pending ranks', summary?.pending_memberships],
            ['Open flags', summary?.open_flags],
            ['Panic alerts', summary?.panic_alerts],
            ['Drivers pending', summary?.drivers_pending],
          ].map(([label, val]) => (
            <div className="adm-stat" key={label}>
              <span>{label}</span>
              <strong>{val ?? '—'}</strong>
            </div>
          ))}
        </section>
      )}

      {tab === 'users' && (
        <section className="adm-card">
          <div className="adm-toolbar">
            <h3>Users</h3>
            <select
              value={roleFilter}
              onChange={(e) => setRoleFilter(e.target.value)}
            >
              <option value="">All roles</option>
              <option value="passenger">Passenger</option>
              <option value="driver">Driver</option>
              <option value="operator">Operator</option>
              <option value="admin">Admin</option>
            </select>
            <button type="button" className="adm-btn ghost" onClick={loadUsers}>
              Refresh
            </button>
          </div>
          <table className="adm-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Contact</th>
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
                    <small>{u.username}</small>
                  </td>
                  <td>
                    {u.phone || '—'}
                    <small>{u.email || ''}</small>
                  </td>
                  <td>
                    <span className="adm-pill">{u.role}</span>
                  </td>
                  <td>{u.is_active ? 'Yes' : 'No'}</td>
                  <td>
                    <button
                      type="button"
                      className="adm-btn ghost"
                      disabled={busy}
                      onClick={() => toggleActive(u)}
                    >
                      {u.is_active ? 'Deactivate' : 'Activate'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {tab === 'drivers' && (
        <section className="adm-card">
          <div className="adm-toolbar">
            <h3>Drivers</h3>
            <button type="button" className="adm-btn ghost" onClick={loadDrivers}>
              Refresh
            </button>
          </div>
          <table className="adm-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Phone</th>
                <th>Licence</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {drivers.map((d) => (
                <tr key={d.id}>
                  <td>{d.name}</td>
                  <td>{d.phone || '—'}</td>
                  <td>{d.license_number}</td>
                  <td>
                    <span className={`adm-pill status-${d.status}`}>
                      {d.status}
                    </span>
                  </td>
                  <td className="adm-actions">
                    {d.status === 'pending' && (
                      <>
                        <button
                          type="button"
                          className="adm-btn primary"
                          disabled={busy}
                          onClick={() => verifyDriver(d.id, 'verify')}
                        >
                          Verify
                        </button>
                        <button
                          type="button"
                          className="adm-btn ghost"
                          disabled={busy}
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
        </section>
      )}

      {tab === 'memberships' && (
        <section className="adm-card">
          <div className="adm-toolbar">
            <h3>Pending rank memberships</h3>
            <button
              type="button"
              className="adm-btn ghost"
              onClick={loadMemberships}
            >
              Refresh
            </button>
          </div>
          {memberships.length === 0 && (
            <p className="adm-hint">No pending requests.</p>
          )}
          <ul className="adm-list">
            {memberships.map((m) => (
              <li key={m.id}>
                <div>
                  <strong>{m.operator_name}</strong>
                  <small>
                    {m.operator_phone} · Rank: {m.rank_name}
                  </small>
                </div>
                <div className="adm-actions">
                  <button
                    type="button"
                    className="adm-btn primary"
                    disabled={busy}
                    onClick={() => decideMembership(m.id, 'approve')}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    className="adm-btn ghost"
                    disabled={busy}
                    onClick={() => decideMembership(m.id, 'reject')}
                  >
                    Reject
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {tab === 'flags' && (
        <section className="adm-card">
          <div className="adm-toolbar">
            <h3>Trip flags</h3>
            <button type="button" className="adm-btn ghost" onClick={loadFlags}>
              Refresh
            </button>
          </div>
          <table className="adm-table">
            <thead>
              <tr>
                <th>Trip</th>
                <th>Category</th>
                <th>Status</th>
                <th>By</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {flags.map((f) => (
                <tr key={f.id}>
                  <td>{f.trip_code || f.trip_id}</td>
                  <td>{f.category}</td>
                  <td>{f.status}</td>
                  <td>{f.flagged_by || '—'}</td>
                  <td>{f.notes || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {tab === 'panics' && (
        <section className="adm-card">
          <div className="adm-toolbar">
            <h3>Panic alerts</h3>
            <button type="button" className="adm-btn ghost" onClick={loadPanics}>
              Refresh
            </button>
          </div>
          <table className="adm-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>User</th>
                <th>Trip</th>
                <th>Location</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {panics.map((p) => (
                <tr key={p.id}>
                  <td>{p.id}</td>
                  <td>{p.user || '—'}</td>
                  <td>{p.trip_id || '—'}</td>
                  <td>{p.lat != null ? `${p.lat}, ${p.lng}` : '—'}</td>
                  <td>
                    {p.created_at
                      ? new Date(p.created_at).toLocaleString()
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}