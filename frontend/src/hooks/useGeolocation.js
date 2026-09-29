/**
 * useGeolocation — small wrapper around the browser Geolocation API.
 *
 * Returns:
 *   position    : { lat, lng, accuracy } | null
 *   error       : string | null
 *   loading     : boolean
 *   requestOnce : () => void   // one-shot fetch (safe to call repeatedly)
 *   watch       : () => void   // start a watchPosition subscription
 *   stop        : () => void   // stop the subscription
 */
import { useCallback, useEffect, useRef, useState } from 'react';

function _secure() {
  try {
    if (typeof window !== 'undefined' && window.isSecureContext) return true;
    const h = window.location.hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
  } catch {
    return false;
  }
}

export function useGeolocation() {
  const [position, setPosition] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const watchRef = useRef(null);

  const _apply = (coords) => {
    setPosition({
      lat: coords.latitude,
      lng: coords.longitude,
      accuracy: coords.accuracy ?? 0,
    });
  };

  const requestOnce = useCallback(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setError('Geolocation not available.');
      return;
    }
    if (!_secure()) {
      // Browsers block geolocation on http://192.168.x.x — don't spin forever.
      setError('Geolocation requires localhost or HTTPS.');
      return;
    }
    setLoading(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        _apply(pos.coords);
        setError(null);
        setLoading(false);
      },
      (err) => {
        setError(err.message || 'Could not read location.');
        setLoading(false);
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 5000 }
    );
  }, []);

  const watch = useCallback(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setError('Geolocation not available.');
      return;
    }
    if (!_secure()) {
      setError('Geolocation requires localhost or HTTPS.');
      return;
    }
    if (watchRef.current != null) return; // already watching
    watchRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        _apply(pos.coords);
        setError(null);
      },
      (err) => setError(err.message || 'Location error.'),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 3000 }
    );
  }, []);

  const stop = useCallback(() => {
    if (watchRef.current != null && navigator?.geolocation) {
      navigator.geolocation.clearWatch(watchRef.current);
      watchRef.current = null;
    }
  }, []);

  useEffect(() => () => stop(), [stop]);

  return { position, error, loading, requestOnce, watch, stop };
}

export default useGeolocation;