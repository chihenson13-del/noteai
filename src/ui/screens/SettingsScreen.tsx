import { useEffect, useState } from 'react';
import { ExternalLink, LogOut, ShieldCheck } from 'lucide-react';
import { backend } from '../../app/backend';
import { localStore } from '../../app/localStore';
import { env } from '../../config/env';
import { QUALITY_LABEL, MAX_PROCESSABLE_BYTES, minutesWithinLimit } from '../../domain/audioMime';
import { ON_DEVICE_MODELS } from '../../ondevice/config';
import { clearModelCache, isOnDeviceSupported, modelCacheSummary } from '../../ondevice/transcriber';
import { displayName } from '../../domain/auth';
import { LANGUAGE_OPTIONS } from '../../domain/schemas';
import type { OnDeviceModelId, RecordingQuality, SummaryLength } from '../../domain/types';
import { errorMessage } from '../../lib/errors';
import { formatBytes } from '../../lib/format';
import { ScreenWakeLock } from '../../recording/wakeLock';
import { useAuthStore } from '../../state/authStore';
import { useLibraryStore } from '../../state/libraryStore';
import { useSettingsStore } from '../../state/settingsStore';
import { toast } from '../../state/toastStore';
import { Banner, Button, Card, LinkButton, Segmented } from '../components/primitives';

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <Card>
      <h2 className="h2">{title}</h2>
      {description && <p className="muted small" style={{ marginTop: 4 }}>{description}</p>}
      <div style={{ marginTop: 12 }}>{children}</div>
    </Card>
  );
}

function Toggle({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="check setting">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <span className="label">{label}</span>
        {hint && <span className="hint" style={{ display: 'block' }}>{hint}</span>}
      </span>
    </label>
  );
}

function ChangePasswordForm({ recovering }: { recovering: boolean }) {
  const updatePassword = useAuthStore((s) => s.updatePassword);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    if (password.length < 8) return setError('Use at least 8 characters.');
    if (password !== confirm) return setError('The two passwords do not match.');
    setBusy(true);
    try {
      await updatePassword(password);
      setPassword('');
      setConfirm('');
      toast.success('Password updated.');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="stack" onSubmit={(e) => void submit(e)} noValidate>
      {recovering && (
        <Banner tone="info" title="Choose a new password">
          You followed a password-reset link. Set a new password below to finish.
        </Banner>
      )}
      <div className="field">
        <label className="label" htmlFor="new-password">
          New password
        </label>
        <input
          id="new-password"
          className="input"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      <div className="field">
        <label className="label" htmlFor="confirm-password">
          Confirm new password
        </label>
        <input
          id="confirm-password"
          className="input"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
      </div>
      {error && (
        <p className="small" role="alert" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      )}
      <div>
        <Button type="submit" variant="secondary" loading={busy}>
          Update password
        </Button>
      </div>
    </form>
  );
}

interface StorageNumbers {
  localBytes: number;
  localCount: number;
  quota: number | null;
  usage: number | null;
  persisted: boolean | null;
}

export function SettingsScreen() {
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  const recordings = useLibraryStore((s) => s.recordings);
  const user = useAuthStore((s) => s.user);
  const authStatus = useAuthStore((s) => s.status);
  const signOut = useAuthStore((s) => s.signOut);
  const recovering = useAuthStore((s) => s.recovering);

  const [storage, setStorage] = useState<StorageNumbers | null>(null);
  const [modelFiles, setModelFiles] = useState<number | null>(null);
  const onDeviceSupported = isOnDeviceSupported();

  useEffect(() => {
    void modelCacheSummary().then((summary) => setModelFiles(summary.supported ? summary.files : null));
  }, []);

  const cloudAudio = recordings.filter((r) => r.remotePath !== null);
  const cloudBytes = cloudAudio.reduce((sum, r) => sum + r.sizeBytes, 0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [localBytes, estimate, persisted] = await Promise.all([
        localStore.localAudioBytes().catch(() => 0),
        navigator.storage?.estimate?.().catch(() => undefined),
        navigator.storage?.persisted?.().catch(() => undefined),
      ]);
      if (cancelled) return;
      setStorage({
        localBytes,
        localCount: recordings.filter((r) => r.hasLocalAudio).length,
        quota: estimate?.quota ?? null,
        usage: estimate?.usage ?? null,
        persisted: persisted ?? null,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [recordings]);

  return (
    <div className="page">
      <header>
        <h1 className="h1 display">Settings</h1>
      </header>

      <Section title="Recording" description="Applies to new recordings made in this browser.">
        <div className="stack" role="radiogroup" aria-label="Recording quality">
          {(Object.keys(QUALITY_LABEL) as RecordingQuality[]).map((quality) => (
            <label key={quality} className="check card card--soft card--tight">
              <input
                type="radio"
                name="quality"
                checked={settings.quality === quality}
                onChange={() => void update({ quality })}
              />
              <span>
                <span className="label">{QUALITY_LABEL[quality].name}</span>
                <span className="hint" style={{ display: 'block' }}>
                  {QUALITY_LABEL[quality].description} · about {minutesWithinLimit(quality, MAX_PROCESSABLE_BYTES)} min fits the{' '}
                  {formatBytes(MAX_PROCESSABLE_BYTES)} transcription limit
                </span>
              </span>
            </label>
          ))}
        </div>
        <Toggle
          label="Keep the screen awake while recording"
          hint={
            ScreenWakeLock.isSupported()
              ? 'Uses the Screen Wake Lock API. It helps, but cannot guarantee recording if your device locks or suspends the browser.'
              : 'Your browser does not support the Screen Wake Lock API, so this has no effect here.'
          }
          checked={settings.keepScreenAwake}
          onChange={(keepScreenAwake) => void update({ keepScreenAwake })}
        />
      </Section>

      <Section title="Language & transcription">
        <div className="field">
          <label className="label" htmlFor="language">
            Spoken language
          </label>
          <select id="language" className="select" value={settings.language} onChange={(e) => void update({ language: e.target.value })}>
            {LANGUAGE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <span className="hint">Choosing the language usually improves accuracy. “Detect automatically” works for most recordings.</span>
        </div>
        <div className="stack" style={{ marginTop: 14 }}>
          <span className="label">Transcription runs on this device</span>
          {!onDeviceSupported && (
            <Banner tone="warning">This browser can’t run the on-device transcriber (it needs Web Workers, WebAssembly and Web Audio).</Banner>
          )}
          <div className="stack" role="radiogroup" aria-label="On-device speech model">
            {(Object.keys(ON_DEVICE_MODELS) as OnDeviceModelId[]).map((model) => (
              <label key={model} className="check card card--soft card--tight">
                <input
                  type="radio"
                  name="onDeviceModel"
                  checked={settings.onDeviceModel === model}
                  onChange={() => void update({ onDeviceModel: model })}
                />
                <span>
                  <span className="label">
                    {ON_DEVICE_MODELS[model].label} · about {ON_DEVICE_MODELS[model].approxMb} MB
                  </span>
                  <span className="hint" style={{ display: 'block' }}>
                    {ON_DEVICE_MODELS[model].description}
                  </span>
                </span>
              </label>
            ))}
          </div>
          <p className="tiny muted">
            The model is downloaded from this site the first time you transcribe, then kept in your browser so it works offline. Audio is
            never uploaded for on-device transcription.
          </p>
          <div className="row-wrap">
            <Button
              variant="secondary"
              size="sm"
              disabled={modelFiles === 0 || modelFiles === null}
              onClick={() =>
                void clearModelCache().then((ok) => {
                  if (ok) {
                    setModelFiles(0);
                    toast.success('Downloaded speech models removed. They download again the next time you transcribe.');
                  } else toast.error('Could not remove the downloaded models.');
                })
              }
            >
              Remove downloaded models
            </Button>
            <span className="tiny muted">
              {modelFiles === null ? 'Model storage is not available in this browser.' : modelFiles === 0 ? 'No model downloaded yet.' : `${modelFiles} model files stored on this device.`}
            </span>
          </div>
        </div>
      </Section>

      <Section title="Notes" description="Used for new and regenerated notes.">
        <div className="field">
          <span className="label">Length</span>
          <Segmented<SummaryLength>
            label="Summary length"
            value={settings.summaryLength}
            onChange={(summaryLength) => void update({ summaryLength })}
            options={[
              { value: 'brief', label: 'Brief' },
              { value: 'standard', label: 'Standard' },
              { value: 'detailed', label: 'Detailed' },
            ]}
          />
        </div>
        <Toggle label="Extract action items" checked={settings.extractActionItems} onChange={(v) => void update({ extractActionItems: v })} />
        <Toggle label="Extract decisions" checked={settings.extractDecisions} onChange={(v) => void update({ extractDecisions: v })} />
      </Section>

      <Section title="Storage">
        <div className="stack">
          <div className="spread">
            <span>Audio on this device</span>
            <strong>
              {storage ? `${formatBytes(storage.localBytes)} · ${storage.localCount} file${storage.localCount === 1 ? '' : 's'}` : '…'}
            </strong>
          </div>
          {storage?.quota ? (
            <div>
              <div className="meter" aria-hidden>
                <div style={{ width: `${Math.min(100, ((storage.usage ?? 0) / storage.quota) * 100)}%` }} />
              </div>
              <p className="tiny muted" style={{ marginTop: 6 }}>
                Browser storage: {formatBytes(storage.usage ?? 0)} of about {formatBytes(storage.quota)} available to this site.
                {storage.persisted === false && ' Your browser may clear this data if the device runs low on space.'}
              </p>
            </div>
          ) : null}
          <div className="spread">
            <span>Audio in the cloud</span>
            <strong>{backend ? `${formatBytes(cloudBytes)} · ${cloudAudio.length} file${cloudAudio.length === 1 ? '' : 's'}` : 'Not configured'}</strong>
          </div>
        </div>
      </Section>

      <Section title="Account">
        {!backend ? (
          <Banner tone="info">No backend is configured, so there are no accounts: everything stays in this browser.</Banner>
        ) : authStatus === 'loading' ? (
          <p className="muted">Checking your session…</p>
        ) : user ? (
          <div className="stack">
            <p>
              Signed in as <strong>{displayName(user)}</strong>
            </p>
            {user.viaCode && (
              <p className="small muted">
                Signed in with an access code, which is bound to this device.
                {user.contactEmail ? ` Contact email on file: ${user.contactEmail}.` : ''}
              </p>
            )}
            <div className="row-wrap">
              <Button variant="secondary" icon={<LogOut />} onClick={() => void signOut().catch((e) => toast.error(errorMessage(e)))}>
                Sign out
              </Button>
            </div>
            {!user.viaCode && (
              <div className="setting">
                <ChangePasswordForm recovering={recovering} />
              </div>
            )}
          </div>
        ) : (
          <div className="stack">
            <p className="muted">
              Sign in with an access code to create share links. Recording, transcribing and notes on this device work without signing in.
            </p>
            <div>
              <LinkButton to="/auth" variant="primary">
                Sign in with an access code
              </LinkButton>
            </div>
          </div>
        )}
      </Section>

      <Section title="Privacy & data" description="Consent, the activity log, retention and deletion all live in one place.">
        <LinkButton to="/trust" variant="secondary" icon={<ShieldCheck />}>
          Open the Trust center
        </LinkButton>
      </Section>

      <Section title="About & legal">
        <div className="stack">
          <p className="muted small row" style={{ alignItems: 'flex-start' }}>
            <ShieldCheck size={18} aria-hidden style={{ flex: 'none', marginTop: 2 }} />
            <span>
              NoteAI is a web app: it runs in your browser and nothing needs installing. Recording can’t be guaranteed while your
              screen is off or the browser is in the background.
            </span>
          </p>
          <div className="row-wrap">
            {env.privacyPolicyUrl ? (
              <a className="btn btn--secondary btn--sm" href={env.privacyPolicyUrl} target="_blank" rel="noopener noreferrer">
                Privacy policy <ExternalLink aria-hidden />
              </a>
            ) : (
              <LinkButton to="/privacy" variant="secondary" size="sm">
                Privacy &amp; terms
              </LinkButton>
            )}
            {env.termsUrl && (
              <a className="btn btn--secondary btn--sm" href={env.termsUrl} target="_blank" rel="noopener noreferrer">
                Terms of service <ExternalLink aria-hidden />
              </a>
            )}
          </div>
        </div>
      </Section>
    </div>
  );
}
