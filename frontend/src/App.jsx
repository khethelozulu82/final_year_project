import { useCallback, useEffect, useState } from 'react';
import {
  api,
  clearSession,
  getApiBase,
  getToken,
  getUser,
  setApiBase,
  setSession,
} from './api';
import PassengerMapDashboard from './pages/PassengerMapDashboard.jsx';
import DriverPage from './pages/DriverPage.jsx';
import RankFlowOperatorPage from './pages/RankFlowOperatorPage.jsx';
import RankFlowAdminPage from './pages/RankFlowAdminPage.jsx';
import './styles/operatorFyp.css';
import './styles/authPage.css';

const DEMOS = [
  { label: 'Passenger', ident: 'passenger_demo', role: 'passenger' },
  { label: 'Driver', ident: 'driver_demo', role: 'driver' },
  { label: 'Operator', ident: 'operator_demo', role: 'operator' },
  { label: 'Admin', ident: 'admin_demo', role: 'admin' },
];

const ROLES = ['passenger', 'driver', 'operator'];

export default function App() {
  const [user, setUser] = useState(getUser());
  const [token, setToken] = useState(getToken());
  const [screen, setScreen] = useState('welcome'); // welcome | login | register
  const [role, setRole] = useState('passenger');
  const [darkMode, setDarkMode] = useState(true);
  const [toast, setToast] = useState('');
  const [apiBase, setApiBaseState] = useState(getApiBase());
  const [health, setHealth] = useState(null);

  const notify = useCallback((msg) => {
    setToast(msg);
    setTimeout(() => setToast(''), 3200);
  }, []);

  const refreshHealth = useCallback(async () => {
    try {
      setHealth(await api.health());
    } catch (e) {
      setHealth({ status: 'down', error: e.message });
    }
  }, []);

  useEffect(() => {
    refreshHealth();
  }, [apiBase, refreshHealth]);

  function handleLogout() {
    api.logout().catch(() => {});
    clearSession();
    setToken(null);
    setUser(null);
    setScreen('welcome');
    notify('Signed out');
  }

  function handleAuthed(data) {
    setSession(data.token, data.user);
    setToken(data.token);
    setUser(data.user);
    notify(`Signed in as ${data.user.role}`);
  }

  // ——— Logged in: full-bleed role dashboards ———
  if (token && user) {
    const r = user.role === 'administrator' ? 'admin' : user.role;
    return (
      <>
        {r === 'passenger' && (
          <PassengerMapDashboard notify={notify} onExit={handleLogout} />
        )}
        {r === 'driver' && <DriverPage notify={notify} onExit={handleLogout} />}
        {r === 'operator' && (
          <RankFlowOperatorPage notify={notify} onExit={handleLogout} />
        )}
        {r === 'admin' && (
          <RankFlowAdminPage notify={notify} onExit={handleLogout} />
        )}
        {toast && (
          <div className="toast" role="status">
            {toast}
          </div>
        )}
      </>
    );
  }

  // ——— Auth screens ———
  return (
    <div className="auth-screen">
      <div className="auth-screen-inner">
        {screen === 'welcome' && (
          <Welcome
            onLogin={() => setScreen('login')}
            onRegister={() => {
              setRole('passenger');
              setScreen('register');
            }}
          />
        )}

        {screen === 'login' && (
          <Login
            apiBase={apiBase}
            setApiBaseState={setApiBaseState}
            onBack={() => setScreen('welcome')}
            onAuthed={handleAuthed}
            notify={notify}
            health={health}
            onRegister={() => {
              setRole('passenger');
              setScreen('register');
            }}
          />
        )}

        {screen === 'register' && (
          <Register
            role={role}
            setRole={setRole}
            apiBase={apiBase}
            setApiBaseState={setApiBaseState}
            onBack={() => setScreen('welcome')}
            onAuthed={handleAuthed}
            notify={notify}
          />
        )}
      </div>

      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Welcome                                                            */
/* ------------------------------------------------------------------ */
function Welcome({ onLogin, onRegister }) {
  return (
    <section className="auth-card auth-welcome">
      <span className="auth-eyebrow">SOUTH AFRICAN TRANSPORT PLATFORM</span>
      <h1 className="auth-h1">
        Travel information.
        <br />
        <span className="auth-h1-em">Verified trips.</span>
        <br />
        Safer journeys.
      </h1>
      <p className="auth-sub">
        Find the right route, understand the fare, and connect every completed trip to
        accountable passenger feedback.
      </p>
      <div className="auth-actions">
        <button className="auth-btn primary" onClick={onLogin} type="button">
          Sign in
        </button>
        <button className="auth-btn ghost" onClick={onRegister} type="button">
          Create an account
        </button>
      </div>
      <div className="auth-features">
        <span>01 / Route clarity</span>
        <span>02 / Trip verification</span>
        <span>03 / Accountable feedback</span>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Login                                                              */
/* ------------------------------------------------------------------ */
function Login({
  apiBase,
  setApiBaseState,
  onBack,
  onAuthed,
  notify,
  health,
  onRegister,
}) {
  const [ident, setIdent] = useState('passenger_demo');
  const [password, setPassword] = useState('themba123');
  const [activeRole, setActiveRole] = useState('passenger');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e) {
    e?.preventDefault?.();
    setError('');
    if (!ident || !password) {
      setError('Username / phone / email and password are required.');
      return;
    }
    setBusy(true);
    try {
      setApiBase(apiBase);
      const data = await api.login(ident.trim(), password);
      onAuthed(data);
    } catch (err) {
      setError(err.message || 'Login failed.');
    } finally {
      setBusy(false);
    }
  }

  function pickRole(roleKey) {
    setActiveRole(roleKey);
    const demo = DEMOS.find((d) => d.role === roleKey);
    if (demo) {
      setIdent(demo.ident);
      setPassword('themba123');
      setError('');
    }
  }

  return (
    <section className="auth-card auth-login">
      <button className="auth-back" onClick={onBack} type="button">
        ← Back
      </button>

      <span className="auth-eyebrow">SECURE ACCESS</span>
      <h1 className="auth-h1">Welcome back.</h1>
      <p className="auth-sub">Choose your role to open the relevant dashboard.</p>

      <div className="auth-tabs" role="tablist">
        {DEMOS.map((d) => (
          <button
            key={d.role}
            type="button"
            role="tab"
            aria-selected={activeRole === d.role}
            className={activeRole === d.role ? 'auth-tab active' : 'auth-tab'}
            onClick={() => pickRole(d.role)}
          >
            {d.label}
          </button>
        ))}
      </div>

      <form onSubmit={handleSubmit}>
        <label className="auth-label">
          Username / phone / email
          <input
            className="auth-input"
            value={ident}
            onChange={(e) => setIdent(e.target.value)}
            placeholder="passenger_demo or 082…"
            autoComplete="username"
          />
        </label>

        <label className="auth-label">
          Password
          <input
            className="auth-input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            autoComplete="current-password"
          />
        </label>

        {error && <p className="auth-error">{error}</p>}

        <button
          className="auth-btn primary full"
          type="submit"
          disabled={busy}
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        <p className="auth-hint">
          Demo password: <code>themba123</code>
          {health?.status && (
            <span
              style={{
                marginLeft: 8,
                color: health.status === 'ok' ? '#4ade80' : '#f87171',
              }}
            >
              · API {health.status === 'ok' ? 'online' : 'offline'}
            </span>
          )}
        </p>
      </form>

      {typeof onRegister === 'function' && (
        <button
          type="button"
          className="auth-btn ghost full"
          style={{ marginTop: 4 }}
          onClick={onRegister}
        >
          Create an account
        </button>
      )}

      <details className="auth-advanced">
        <summary>Advanced: API base URL</summary>
        <input
          className="auth-input"
          value={apiBase}
          onChange={(e) => setApiBaseState(e.target.value)}
          placeholder="http://127.0.0.1:8000/api"
        />
      </details>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Register                                                           */
/* ------------------------------------------------------------------ */
function Register({
  role,
  setRole,
  apiBase,
  setApiBaseState,
  onBack,
  onAuthed,
  notify,
}) {
  const [form, setForm] = useState({
    first_name: '',
    last_name: '',
    phone: '',
    email: '',
    password: '',
    next_of_kin_name: '',
    next_of_kin_phone: '',
    second_next_of_kin_name: '',
    second_next_of_kin_phone: '',
    license_number: '',
    rank_code: '',
    id_number: '',
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  function set(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  async function handleSubmit(e) {
    e?.preventDefault?.();
    setError('');
    if (!form.phone || !form.password) {
      setError('Phone number and password are required.');
      return;
    }
    setBusy(true);
    try {
      setApiBase(apiBase);
      let data;
      if (role === 'passenger') {
        data = await api.registerPassenger({
          first_name: form.first_name,
          last_name: form.last_name,
          phone: form.phone,
          email: form.email || undefined,
          password: form.password,
          next_of_kin_name: form.next_of_kin_name,
          next_of_kin_phone: form.next_of_kin_phone,
          second_next_of_kin_name: form.second_next_of_kin_name || '',
          second_next_of_kin_phone: form.second_next_of_kin_phone || '',
        });
      } else if (role === 'driver') {
        data = await api.registerDriver({
          first_name: form.first_name,
          last_name: form.last_name,
          phone: form.phone,
          email: form.email || undefined,
          password: form.password,
          license_number: form.license_number,
          rank_code: form.rank_code || undefined,
          id_number: form.id_number || undefined,
        });
      } else if (role === 'operator') {
        data = await api.registerOperator({
          first_name: form.first_name,
          last_name: form.last_name,
          phone: form.phone,
          email: form.email || undefined,
          password: form.password,
          rank_code: form.rank_code,
        });
      } else {
        setError('Administrator accounts are created by invitation only.');
        setBusy(false);
        return;
      }
      onAuthed(data);
    } catch (err) {
      setError(err.message || 'Registration failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="auth-card auth-register">
      <button className="auth-back" onClick={onBack} type="button">
        ← Back
      </button>

      <span className="auth-eyebrow">ACCOUNT REGISTRATION</span>
      <h1 className="auth-h1">Join THEMBA.</h1>
      <p className="auth-sub">
        Passenger accounts are active immediately. Driver accounts may require
        verification. Administrator accounts are invitation-only.
      </p>

      <div className="auth-tabs">
        {ROLES.map((r) => (
          <button
            key={r}
            type="button"
            className={role === r ? 'auth-tab active' : 'auth-tab'}
            onClick={() => setRole(r)}
          >
            {r.charAt(0).toUpperCase() + r.slice(1)}
          </button>
        ))}
      </div>

      <form onSubmit={handleSubmit}>
        <div className="auth-form-grid">
          <label className="auth-label">
            First name
            <input
              className="auth-input"
              value={form.first_name}
              onChange={(e) => set('first_name', e.target.value)}
            />
          </label>
          <label className="auth-label">
            Surname
            <input
              className="auth-input"
              value={form.last_name}
              onChange={(e) => set('last_name', e.target.value)}
            />
          </label>
        </div>

        <label className="auth-label">
          Cellphone number
          <input
            className="auth-input"
            value={form.phone}
            onChange={(e) => set('phone', e.target.value)}
            placeholder="0821234567"
          />
        </label>

        <label className="auth-label">
          Email (optional)
          <input
            className="auth-input"
            value={form.email}
            onChange={(e) => set('email', e.target.value)}
            placeholder="you@example.co.za"
          />
        </label>

        <label className="auth-label">
          Password
          <input
            className="auth-input"
            type="password"
            value={form.password}
            onChange={(e) => set('password', e.target.value)}
          />
        </label>

        {role === 'passenger' && (
          <>
            <label className="auth-label">
              Next of kin — name
              <input
                className="auth-input"
                value={form.next_of_kin_name}
                onChange={(e) => set('next_of_kin_name', e.target.value)}
              />
            </label>
            <label className="auth-label">
              Next of kin — phone
              <input
                className="auth-input"
                value={form.next_of_kin_phone}
                onChange={(e) => set('next_of_kin_phone', e.target.value)}
              />
            </label>
          </>
        )}

        {role === 'driver' && (
          <>
            <label className="auth-label">
              Licence number
              <input
                className="auth-input"
                value={form.license_number}
                onChange={(e) => set('license_number', e.target.value)}
              />
            </label>
            <label className="auth-label">
              Rank / association code (optional)
              <input
                className="auth-input"
                value={form.rank_code}
                onChange={(e) => set('rank_code', e.target.value)}
              />
            </label>
          </>
        )}

        {role === 'operator' && (
          <label className="auth-label">
            Association rank code (required)
            <input
              className="auth-input"
              value={form.rank_code}
              onChange={(e) => set('rank_code', e.target.value)}
              placeholder="e.g. KDL001"
            />
          </label>
        )}

        {error && <p className="auth-error">{error}</p>}

        <button
          className="auth-btn primary full"
          type="submit"
          disabled={busy}
        >
          {busy ? 'Creating account…' : 'Create account'}
        </button>

        <button
          className="auth-btn ghost full"
          type="button"
          onClick={onBack}
        >
          Back to welcome
        </button>
      </form>

      <details className="auth-advanced">
        <summary>Advanced: API base URL</summary>
        <input
          className="auth-input"
          value={apiBase}
          onChange={(e) => setApiBaseState(e.target.value)}
          placeholder="http://127.0.0.1:8000/api"
        />
      </details>
    </section>
  );
}