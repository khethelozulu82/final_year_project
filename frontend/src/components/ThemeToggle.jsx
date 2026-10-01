/**
 * ThemeToggle — a small, self-contained light/dark toggle.
 *
 * Behaviour:
 *   - Reads the current theme from localStorage ('themba_theme').
 *   - Falls back to prefers-color-scheme if no value is stored.
 *   - Applies <html data-theme="light|dark"> so CSS variables react globally.
 *   - Renders a small pill button you can drop into any dashboard top bar.
 *
 * Usage:
 *   import ThemeToggle from '../components/ThemeToggle';
 *   ...
 *   <ThemeToggle />
 */
import { useEffect, useState } from 'react';

const KEY = 'themba_theme';

function initialTheme() {
  if (typeof window === 'undefined') return 'dark';
  try {
    const stored = localStorage.getItem(KEY);
    if (stored === 'light' || stored === 'dark') return stored;
    const prefersLight = window.matchMedia?.('(prefers-color-scheme: light)').matches;
    return prefersLight ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

function applyTheme(theme) {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-theme', theme);
  document.documentElement.style.colorScheme = theme;
}

export default function ThemeToggle({ className = '' }) {
  const [theme, setTheme] = useState(initialTheme);

  useEffect(() => {
    applyTheme(theme);
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      /* ignore storage errors (private mode) */
    }
  }, [theme]);

  function toggle() {
    setTheme((prev) => (prev === 'light' ? 'dark' : 'light'));
  }

  const isLight = theme === 'light';

  return (
    <button
      type="button"
      onClick={toggle}
      title={isLight ? 'Switch to dark mode' : 'Switch to light mode'}
      aria-label={isLight ? 'Switch to dark mode' : 'Switch to light mode'}
      className={className}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 12px',
        borderRadius: 999,
        border: '1px solid var(--tt-border, rgba(148,163,184,0.35))',
        background: 'var(--tt-bg, rgba(15,23,42,0.6))',
        color: 'var(--tt-fg, #e2e8f0)',
        fontSize: 12,
        fontWeight: 700,
        cursor: 'pointer',
        letterSpacing: '0.04em',
        transition: 'background 0.15s ease, border-color 0.15s ease',
      }}
    >
      <span
        aria-hidden
        style={{
          width: 14,
          height: 14,
          borderRadius: '50%',
          display: 'inline-block',
          background: isLight ? '#f59e0b' : '#1e3a8a',
          boxShadow: isLight
            ? '0 0 8px rgba(245,158,11,0.6)'
            : '0 0 8px rgba(56,189,248,0.5)',
        }}
      />
      {isLight ? 'LIGHT' : 'DARK'}
    </button>
  );
}