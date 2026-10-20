import { Suspense, lazy, useEffect } from 'react';
import { BrowserRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { routerBasename } from './config/base';
import { useAuthStore } from './state/authStore';
import { useBootstrap } from './app/useBootstrap';
import { AppShell } from './ui/AppShell';
import { RequireLogin } from './ui/components/RequireLogin';
import { DashboardScreen } from './ui/screens/DashboardScreen';
import { LibraryScreen } from './ui/screens/LibraryScreen';
import { NotFoundScreen } from './ui/screens/NotFoundScreen';
import { RecordScreen } from './ui/screens/RecordScreen';

// Secondary screens are split out of the initial bundle.
const RecordingScreen = lazy(() => import('./ui/screens/RecordingScreen').then((m) => ({ default: m.RecordingScreen })));
const SettingsScreen = lazy(() => import('./ui/screens/SettingsScreen').then((m) => ({ default: m.SettingsScreen })));
const AuthScreen = lazy(() => import('./ui/screens/AuthScreen').then((m) => ({ default: m.AuthScreen })));
const AskScreen = lazy(() => import('./ui/screens/AskScreen').then((m) => ({ default: m.AskScreen })));
const TrustScreen = lazy(() => import('./ui/screens/TrustScreen').then((m) => ({ default: m.TrustScreen })));
const PrivacyScreen = lazy(() => import('./ui/screens/PrivacyScreen').then((m) => ({ default: m.PrivacyScreen })));
const SharedNotesScreen = lazy(() => import('./ui/screens/SharedNotesScreen').then((m) => ({ default: m.SharedNotesScreen })));

function Routed() {
  useBootstrap();
  const recovering = useAuthStore((s) => s.recovering);
  const navigate = useNavigate();
  useEffect(() => {
    if (recovering) navigate('/settings', { replace: true });
  }, [recovering, navigate]);
  return (
    <Routes>
      {/* Public read-only share page: no app chrome, no navigation into the app. */}
      <Route
        path="s/:token"
        element={
          <Suspense fallback={null}>
            <SharedNotesScreen />
          </Suspense>
        }
      />
      {/* Public: readable before signing in. */}
      <Route
        path="privacy"
        element={
          <Suspense fallback={null}>
            <PrivacyScreen />
          </Suspense>
        }
      />
      <Route
        element={
          <RequireLogin>
            <AppShell />
          </RequireLogin>
        }
      >
        <Route index element={<DashboardScreen />} />
        <Route path="record" element={<RecordScreen />} />
        <Route path="library" element={<LibraryScreen />} />
        <Route path="recording/:id" element={<RecordingScreen />} />
        <Route path="recording/:id/:tab" element={<RecordingScreen />} />
        <Route path="ask" element={<AskScreen />} />
        <Route path="trust" element={<TrustScreen />} />
        <Route path="settings" element={<SettingsScreen />} />
        <Route path="auth" element={<AuthScreen />} />
        <Route path="*" element={<NotFoundScreen />} />
      </Route>
    </Routes>
  );
}

export function App() {
  return (
    <BrowserRouter basename={routerBasename()}>
      <Routed />
    </BrowserRouter>
  );
}
