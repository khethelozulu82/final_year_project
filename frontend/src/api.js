const DEFAULT_BASE = 'http://127.0.0.1:8000/api';

export function getApiBase() {
  const stored = localStorage.getItem('themba_api_base');
  if (stored) return stored.replace(/\/$/, '');
  return (import.meta.env.VITE_API_BASE_URL || DEFAULT_BASE).replace(/\/$/, '');
}

export function setApiBase(url) {
  localStorage.setItem('themba_api_base', url.replace(/\/$/, ''));
}

export function getWsBase() {
  const api = getApiBase();
  return api.replace(/^http/, 'ws').replace(/\/api$/, '');
}

const TOKEN_KEY = 'themba_token';
const USER_KEY = 'themba_user';

export function getToken() {
  return sessionStorage.getItem(TOKEN_KEY);
}

export function getUser() {
  try {
    return JSON.parse(sessionStorage.getItem(USER_KEY) || 'null');
  } catch {
    return null;
  }
}

export function setSession(token, user) {
  sessionStorage.setItem(TOKEN_KEY, token);
  sessionStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearSession() {
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(USER_KEY);
}

async function request(path, { method = 'GET', body, auth = false } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth) {
    const t = getToken();
    if (t) headers.Authorization = `Token ${t}`;
  }
  let res;
  try {
    res = await fetch(`${getApiBase()}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error(
      `Cannot reach API at ${getApiBase()}. Check host IP and that the server is running.`
    );
  }
  const isJson = res.headers.get('content-type')?.includes('application/json');
  const data = isJson ? await res.json() : null;
  if (!res.ok) {
    const msg = data?.detail || data?.error || `Request failed (${res.status})`;
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  return data;
}

export const api = {
  // ---------- Auth ----------
  health: () => request('/health/'),
  login: (ident, password) =>
    request('/auth/login/', {
      method: 'POST',
      body: {
        username: ident,
        phone: ident,
        email: ident.includes('@') ? ident : undefined,
        password,
      },
    }),
  me: () => request('/auth/me/', { auth: true }),
  logout: () => request('/auth/logout/', { method: 'POST', auth: true }),

  registerPassenger: (body) =>
    request('/auth/register/passenger/', { method: 'POST', body }),
  registerDriver: (body) =>
    request('/auth/register/driver/', { method: 'POST', body }),
  registerOperator: (body) =>
    request('/auth/register/operator/', { method: 'POST', body }),

  // ---------- Catalogue ----------
  listTrips: (params = {}) => {
    const q = new URLSearchParams(params).toString();
    return request(`/trips/${q ? `?${q}` : ''}`);
  },
  listRoutes: () => request('/routes/'),
  listRanks: () => request('/ranks/'),
  listDestinations: () => request('/destinations/'),
  tripDetail: (tripId) => request(`/trips/${tripId}/`),
  tripLive: (tripId) => request(`/trips/${tripId}/live/`, { auth: true }),

  // ---------- Passenger booking ----------
  createBooking: (tripId, tripCode, extra = {}) =>
    request('/bookings/', {
      method: 'POST',
      auth: true,
      body: {
        ...(tripId != null ? { trip_id: tripId } : {}),
        ...(tripCode ? { trip_code: tripCode } : {}),
        ...extra,
      },
    }),
  // myBookings({ include: 'all' }) → returns archived (cancelled/completed) too
  myBookings: (opts = {}) => {
    const qs = opts.include === 'all' ? '?include=all' : '';
    return request(`/bookings/mine/${qs}`, { auth: true });
  },
  verifyBookingCode: (code) =>
    request('/bookings/verify-code/', {
      method: 'POST',
      auth: true,
      body: { code: String(code || '').trim().toUpperCase() },
    }),

  // ---------- Operator ----------
  myTrips: () => request('/my-trips/', { auth: true }),
  manifest: (tripId) => request(`/my-trips/${tripId}/manifest/`, { auth: true }),
  engage: (tripId) =>
    request(`/my-trips/${tripId}/engage/`, { method: 'POST', auth: true, body: {} }),
  release: (tripId) =>
    request(`/my-trips/${tripId}/release/`, { method: 'POST', auth: true, body: {} }),
  cancelTrip: (tripId, reason = '') =>
    request(`/my-trips/${tripId}/cancel/`, {
      method: 'POST',
      auth: true,
      body: { reason },
    }),
  walkIn: (tripId, payload) =>
    request(`/my-trips/${tripId}/walk-in/`, { method: 'POST', auth: true, body: payload }),
  verifyBooking: (tripId, bookingId, code) =>
    request(`/my-trips/${tripId}/bookings/${bookingId}/verify/`, {
      method: 'POST',
      auth: true,
      body: { code },
    }),
  myMemberships: () => request('/my-memberships/', { auth: true }),
  requestRank: (rankId, notes = '') =>
    request('/request-rank/', {
      method: 'POST',
      auth: true,
      body: { rank_id: rankId, notes },
    }),

  // ---------- Driver ----------
  myVehicle: () => request('/vehicles/mine/', { auth: true }),
  postLocation: (vehicleId, payload) =>
    request(`/vehicles/${vehicleId}/location/`, {
      method: 'POST',
      auth: true,
      body: payload,
    }),
  driverTrips: () => request('/driver/trips/', { auth: true }),
  driverProfile: () => request('/driver/profile/', { auth: true }),
  notificationsMarkRead: (id) =>
    request(`/driver/notifications/${id}/read/`, { method: 'POST', auth: true }),
  notificationsMarkAllRead: () =>
    request('/driver/notifications/read-all/', { method: 'POST', auth: true }),
  confirmTrip: (tripCode) =>
    request('/driver/confirm-trip/', {
      method: 'POST',
      auth: true,
      body: { trip_code: tripCode },
    }),

  // ---------- Fleet / routing ----------
  fleet: () => request('/fleet/', { auth: true }),
  directions: (origin, destination) =>
    request('/routing/directions/', {
      method: 'POST',
      body: { origin, destination },
    }),
  calculateRouteFare: (payload) =>
    request('/routing/calculate/', { method: 'POST', body: payload }),

  // ---------- Panic ----------
  panic: (payload) =>
    request('/panic-alerts/', { method: 'POST', auth: true, body: payload }),

  // ---------- Admin ----------
  adminSummary: () => request('/admin/summary/', { auth: true }),
  adminUsers: (role = '') =>
    request(`/admin/users/${role ? `?role=${encodeURIComponent(role)}` : ''}`, {
      auth: true,
    }),
  adminSetUserActive: (userId, is_active) =>
    request(`/admin/users/${userId}/set-active/`, {
      method: 'POST',
      auth: true,
      body: { is_active },
    }),
  adminMemberships: (status = 'pending') =>
    request(`/admin/memberships/?status=${encodeURIComponent(status)}`, { auth: true }),
  adminMembershipDecide: (id, decision) =>
    request(`/admin/memberships/${id}/decide/`, {
      method: 'POST',
      auth: true,
      body: { decision },
    }),
  adminFlags: () => request('/admin/flags/', { auth: true }),
  adminPanics: () => request('/admin/panics/', { auth: true }),
  adminDrivers: () => request('/admin/drivers/', { auth: true }),
  adminDriverVerify: (driverId, decision = 'verify') =>
    request(`/admin/drivers/${driverId}/verify/`, {
      method: 'POST',
      auth: true,
      body: { decision },
    }),
  adminTripOptions: () => request('/admin/trip-options/', { auth: true }),
  adminTripQueue: (status = '') =>
    request(`/admin/trips/${status ? `?status=${encodeURIComponent(status)}` : ''}`, {
      auth: true,
    }),
  adminScheduleTrip: (payload) =>
    request('/admin/trips/schedule/', { method: 'POST', auth: true, body: payload }),
  adminUpdateTrip: (tripId, payload) =>
    request(`/admin/trips/${tripId}/`, { method: 'PATCH', auth: true, body: payload }),
  adminDeleteTrip: (tripId) =>
    request(`/admin/trips/${tripId}/`, { method: 'DELETE', auth: true }),
  adminOverview: () => request('/admin/overview/', { auth: true }),
  adminAnnouncements: () => request('/admin/announcements/', { auth: true }),
  adminCreateAnnouncement: (payload) =>
    request('/admin/announcements/', { method: 'POST', auth: true, body: payload }),
  adminUpdateAnnouncement: (id, payload) =>
    request(`/admin/announcements/${id}/`, { method: 'PATCH', auth: true, body: payload }),
  adminComplaints: () => request('/admin/complaints/', { auth: true }),
  escalateComplaint: (id, reason) =>
    request(`/admin/complaints/${id}/escalate/`, {
      method: 'POST',
      auth: true,
      body: { reason },
    }),
  adminReviewComplaint: (id, payload) =>
    request(`/admin/complaints/${id}/review/`, {
      method: 'POST',
      auth: true,
      body: payload,
    }),
  adminSafety: () => request('/admin/safety/', { auth: true }),
  adminSafetyDecide: (id, payload) =>
    request(`/admin/safety/${id}/decide/`, { method: 'POST', auth: true, body: payload }),
  adminPanicsLive: () => request('/admin/panics/live/', { auth: true }),
  adminSimulateTrip: (trip_id, step = 'next') =>
    request('/admin/trips/simulate/', {
      method: 'POST',
      auth: true,
      body: { trip_id, step },
    }),

  // ---------- History ----------
  history: () => request('/history/', { auth: true }),

  // ---------- Ratings ----------
  rateDriver: (payload) =>
    request('/ratings/', { method: 'POST', auth: true, body: payload }),
  driverRatingSummary: (driverId) =>
    request(`/drivers/${driverId}/rating/`, { auth: true }),

  // ---------- Ride requests ----------
  createRideRequest: (payload) =>
    request('/ride-requests/', { method: 'POST', auth: true, body: payload }),
  getRideRequest: (id) => request(`/ride-requests/${id}/`, { auth: true }),
  acceptRideRequest: (id) =>
    request(`/ride-requests/${id}/accept/`, { method: 'POST', auth: true, body: {} }),
  rejectRideRequest: (id) =>
    request(`/ride-requests/${id}/reject/`, { method: 'POST', auth: true, body: {} }),

  // ---------- Passenger notifications / announcements ----------
  passengerNotifications: () =>
    request('/passenger/notifications/', { auth: true }),
  passengerAnnouncements: () =>
    request('/passenger/announcements/', { auth: true }),
  passengerNotificationRead: (id) =>
    request(`/passenger/notifications/${id}/read/`, {
      method: 'POST',
      auth: true,
    }),

  // ---------- Passenger complaints / history ----------
  fileComplaint: (tripId, payload) =>
    request(`/passenger/trips/${tripId}/file-complaint/`, {
      method: 'POST',
      auth: true,
      body: payload,
    }),
  tripReviewStatus: (tripId) =>
    request(`/passenger/trips/${tripId}/review-status/`, { auth: true }),
  passengerHistory: () => request('/passenger/history/', { auth: true }),

  // ---------- Announcements (operator / shared aliases) ----------
  listAnnouncements: () => request('/announcements/', { auth: true }),
  createAnnouncement: (payload) =>
    request('/announcements/', { method: 'POST', auth: true, body: payload }),
  updateAnnouncement: (id, payload) =>
    request(`/announcements/${id}/`, { method: 'PATCH', auth: true, body: payload }),
  getAnnouncement: (id) => request(`/announcements/${id}/`, { auth: true }),

  // ---------- Operator dashboard / panels ----------
  operatorDashboard: () => request('/operator/dashboard/', { auth: true }),
  operatorDrivers: () => request('/operator/drivers/', { auth: true }),
  operatorComplaints: () => request('/operator/complaints/', { auth: true }),
  operatorPanics: () => request('/operator/panics/', { auth: true }),
  confirmTripAccess: (tripId) =>
    request(`/my-trips/${tripId}/confirm/`, { method: 'POST', auth: true, body: {} }),
  verifyTripAssets: (tripId) =>
    request(`/my-trips/${tripId}/verify-assets/`, { method: 'POST', auth: true, body: {} }),

  // Aliases used by operator console
  listOperatorDrivers: () => request('/operator/drivers/', { auth: true }),
  listOperatorComplaints: () => request('/operator/complaints/', { auth: true }),
};