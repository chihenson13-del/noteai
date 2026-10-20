import { Suspense, useEffect } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { Home, Library, MessageCircle, Mic, Settings, ShieldCheck } from 'lucide-react';
import { isSessionLive } from '../domain/recordingMachine';
import { formatDuration } from '../lib/format';
import { ScreenWakeLock } from '../recording/wakeLock';
import { useSettingsStore } from '../state/settingsStore';
import { useWakeLockStore } from '../state/wakeLockStore';
import { Toasts } from './components/Toasts';
import { SkeletonList } from './components/primitives';
import { useElapsed } from './hooks/useElapsed';
import { useRecorderSnapshot } from './hooks/useRecorder';

interface NavEntry {
  to: string;
  label: string;
  icon: typeof Home;
  end: boolean;
  /** Only in the desktop sidebar (the mobile bar keeps five slots). */
  sidebarOnly?: boolean;
  /** The raised centre button on the mobile bar. */
  primary?: boolean;
}

const NAV: NavEntry[] = [
  { to: '/', label: 'Home', icon: Home, end: true },
  { to: '/library', label: 'Library', icon: Library, end: false },
  { to: '/record', label: 'Record', icon: Mic, end: false, primary: true },
  { to: '/ask', label: 'Ask', icon: MessageCircle, end: false },
  { to: '/settings', label: 'Settings', icon: Settings, end: false },
  { to: '/trust', label: 'Trust center', icon: ShieldCheck, end: false, sidebarOnly: true },
];

/**
 * Side effects that must follow the recorder wherever the user navigates:
 * screen wake lock, "leave page?" guard and a timer in the tab title.
 */
function RecordingEffects() {
  const snapshot = useRecorderSnapshot();
  const keepAwake = useSettingsStore((s) => s.settings.keepScreenAwake);
  const live = isSessionLive(snapshot);
  const capturing = snapshot.phase === 'recording';
  const elapsed = useElapsed(snapshot);

  const setWakeLockState = useWakeLockStore((s) => s.set);

  useEffect(() => {
    if (!capturing) {
      setWakeLockState(!ScreenWakeLock.isSupported() ? 'unsupported' : keepAwake ? 'off' : 'off');
      return;
    }
    if (!keepAwake) {
      setWakeLockState('off');
      return;
    }
    if (!ScreenWakeLock.isSupported()) {
      setWakeLockState('unsupported');
      return;
    }
    const lock = new ScreenWakeLock();
    let cancelled = false;
    void lock.acquire().then(() => {
      if (!cancelled) setWakeLockState(lock.active ? 'active' : 'inactive');
    });
    // The browser drops the lock whenever the page is hidden; reflect what is really held.
    const poll = setInterval(() => setWakeLockState(lock.active ? 'active' : 'inactive'), 1000);
    return () => {
      cancelled = true;
      clearInterval(poll);
      void lock.release();
      setWakeLockState('off');
    };
  }, [capturing, keepAwake, setWakeLockState]);

  useEffect(() => {
    if (!live) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [live]);

  useEffect(() => {
    const base = 'NoteAI';
    if (!live) {
      document.title = base;
      return;
    }
    const prefix = snapshot.phase === 'recording' ? '● ' : snapshot.phase === 'paused' ? '❚❚ ' : '⚠ ';
    document.title = `${prefix}${formatDuration(elapsed)} · ${base}`;
    return () => {
      document.title = base;
    };
  }, [live, snapshot.phase, elapsed]);

  return null;
}

function MiniRecorder() {
  const snapshot = useRecorderSnapshot();
  const elapsed = useElapsed(snapshot);
  const location = useLocation();
  if (!isSessionLive(snapshot) || location.pathname === '/record') return null;
  const label =
    snapshot.phase === 'recording'
      ? 'Recording'
      : snapshot.phase === 'paused'
        ? 'Paused'
        : snapshot.phase === 'interrupted'
          ? 'Interrupted — not recording'
          : snapshot.phase === 'stopping'
            ? 'Saving…'
            : 'Starting…';
  return (
    <Link to="/record" className={`mini-recorder ${snapshot.phase === 'recording' ? 'is-live' : 'is-paused'}`} aria-label={`${label}. Return to recording`}>
      <i aria-hidden />
      <span className="grow truncate">{label}</span>
      <span className="mono">{formatDuration(elapsed)}</span>
    </Link>
  );
}

export function AppShell() {
  return (
    <div className="app">
      <aside className="sidebar" aria-label="Primary">
        <Link to="/" className="brand">
          <span className="brand-mark" aria-hidden>
            <Mic size={18} />
          </span>
          NoteAI
        </Link>
        {NAV.map(({ to, label, icon: Icon, end }) => (
          <NavLink key={to} to={to} end={end} className="nav-link">
            <Icon aria-hidden />
            {label}
          </NavLink>
        ))}
        <div className="sidebar-spacer" />
        <p className="tiny faint" style={{ padding: '0 8px' }}>
          Web app · works in your browser, nothing to install.
        </p>
      </aside>

      <main className="main" id="main">
        <Suspense
          fallback={
            <div className="page">
              <SkeletonList />
            </div>
          }
        >
          <Outlet />
        </Suspense>
      </main>

      <nav className="tabbar" aria-label="Primary">
        {NAV.filter((entry) => !entry.sidebarOnly).map(({ to, label, icon: Icon, end, primary }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) => `nav-link${primary ? ' nav-link--primary' : ''}${isActive ? ' is-active' : ''}`}
            aria-label={label}
          >
            <span className="nav-icon">
              <Icon aria-hidden />
            </span>
            <span className="nav-label">{label}</span>
          </NavLink>
        ))}
      </nav>

      <MiniRecorder />
      <RecordingEffects />
      <Toasts />
    </div>
  );
}
