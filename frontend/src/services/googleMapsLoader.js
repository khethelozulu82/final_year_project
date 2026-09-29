/**
 * Load Google Maps JavaScript API once (script tag, no npm package).
 * Requires VITE_GOOGLE_MAPS_API_KEY in frontend/.env
 */
const API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '';
const LOAD_TIMEOUT_MS = 12000;

let loadPromise = null;

export function loadGoogleMaps() {
  if (loadPromise) return loadPromise;

  loadPromise = new Promise((resolve, reject) => {
    if (!API_KEY) {
      reject(
        new Error(
          'Google Maps is not configured. Set VITE_GOOGLE_MAPS_API_KEY in frontend/.env, then restart npm run dev.'
        )
      );
      loadPromise = null;
      return;
    }

    if (window.google?.maps) {
      resolve(window.google.maps);
      return;
    }

    let settled = false;
    const settleResolve = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      resolve(value);
    };
    const settleReject = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      // Allow a future retry after the key/origin is fixed.
      loadPromise = null;
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    // Reset the cached promise so the next call can retry after fixes.
    window.gm_authFailure = () => {
      settleReject(
        new Error(
          'Google rejected this page’s API key. Check Website restrictions, billing, and that Maps JavaScript API is enabled for this key.'
        )
      );
    };

    const timeoutId = setTimeout(() => {
      settleReject(
        new Error(
          'Google Maps did not respond in time. Check network, ad blockers, and the API key.'
        )
      );
    }, LOAD_TIMEOUT_MS);

    const existing = document.getElementById('themba-google-maps-script');
    if (existing) {
      existing.addEventListener('load', () => settleResolve(window.google.maps));
      existing.addEventListener('error', () =>
        settleReject(new Error('Google Maps failed to load.'))
      );
      return;
    }

    window.__thembaGoogleMapsReady = () => settleResolve(window.google.maps);

    const script = document.createElement('script');
    script.id = 'themba-google-maps-script';
    script.async = true;
    script.src =
      `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(API_KEY)}` +
      '&libraries=places,geometry&v=weekly&loading=async' +
      '&callback=__thembaGoogleMapsReady';
    script.onerror = () => {
      // Reset so a retry after fixing env/key restrictions works.
      const el = document.getElementById('themba-google-maps-script');
      if (el && el.parentNode) el.parentNode.removeChild(el);
      settleReject(
        new Error(
          'Google Maps failed to load. Check VITE_GOOGLE_MAPS_API_KEY and key HTTP referrer restrictions.'
        )
      );
    };
    document.head.appendChild(script);
  });

  return loadPromise;
}

export function hasGoogleMapsKey() {
  return Boolean(API_KEY);
}

export default loadGoogleMaps;