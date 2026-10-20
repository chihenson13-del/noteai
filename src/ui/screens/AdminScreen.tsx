import { useCallback, useEffect, useMemo, useState } from 'react';
import { Copy, Download, KeyRound, Plus, RefreshCw, ShieldOff, Undo2, Unlink } from 'lucide-react';
import { backend } from '../../app/backend';
import type { AdminCode, AdminDevice } from '../../data/backend';
import { copyText, saveText } from '../../lib/download';
import { errorMessage } from '../../lib/errors';
import { formatDateTime } from '../../lib/format';
import { useAuthStore } from '../../state/authStore';
import { toast } from '../../state/toastStore';
import { ConfirmDialog } from '../components/Modal';
import { Badge, Banner, Button, Card, EmptyState, LinkButton, Segmented, Spinner } from '../components/primitives';

type Filter = 'all' | 'unused' | 'in_use' | 'revoked';

const STATUS_LABEL: Record<AdminCode['status'], string> = { unused: 'Unused', in_use: 'In use', revoked: 'Revoked' };
const STATUS_TONE = { unused: 'neutral', in_use: 'success', revoked: 'danger' } as const;

type Pending =
  | { kind: 'revoke'; code: AdminCode }
  | { kind: 'restore'; code: AdminCode }
  | { kind: 'release'; code: AdminCode; device: AdminDevice };

/**
 * Admin tools, only reachable after signing in with an admin code. The server checks that on every call; this screen
 * merely hides what it cannot use.
 */
export function AdminScreen() {
  const isAdmin = useAuthStore((s) => s.isAdmin);
  const [codes, setCodes] = useState<AdminCode[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [count, setCount] = useState(5);
  const [label, setLabel] = useState('Beta');
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<string[] | null>(null);

  const load = useCallback(async () => {
    if (!backend?.adminListCodes) return;
    try {
      setCodes(await backend.adminListCodes());
      setError(null);
    } catch (e) {
      setError(errorMessage(e, 'Could not load the codes.'));
    }
  }, []);

  useEffect(() => {
    if (isAdmin) void load();
  }, [isAdmin, load]);

  const counts = useMemo(() => {
    const all = codes ?? [];
    return {
      total: all.length,
      unused: all.filter((c) => c.status === 'unused').length,
      in_use: all.filter((c) => c.status === 'in_use').length,
      revoked: all.filter((c) => c.status === 'revoked').length,
    };
  }, [codes]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (codes ?? []).filter((c) => {
      if (filter !== 'all' && c.status !== filter) return false;
      if (!q) return true;
      const haystack = [c.label, c.ownerName, c.ownerEmail, ...c.devices.flatMap((d) => [d.fullName, d.contactEmail, d.label])]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [codes, filter, query]);

  if (!backend?.adminListCodes) {
    return (
      <div className="page">
        <EmptyState icon={<KeyRound />} title="Admin needs the server">
          This site has no backend, so there are no codes to manage.
        </EmptyState>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="page">
        <EmptyState
          icon={<ShieldOff />}
          title="Admins only"
          action={
            <LinkButton to="/" variant="primary">
              Back home
            </LinkButton>
          }
        >
          Sign in with the admin code to manage access codes.
        </EmptyState>
      </div>
    );
  }

  const confirm = async () => {
    if (!pending || !backend?.adminSetRevoked || !backend.adminReleaseDevice) return;
    setBusy(true);
    try {
      if (pending.kind === 'release') {
        await backend.adminReleaseDevice(pending.code.id, pending.device.deviceHash);
        toast.success('Device freed. The code can be used on a new device.');
      } else {
        await backend.adminSetRevoked(pending.code.id, pending.kind === 'revoke');
        toast.success(pending.kind === 'revoke' ? 'Code revoked.' : 'Code restored.');
      }
      setPending(null);
      await load();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    if (!backend?.adminCreateCodes) return;
    setCreating(true);
    try {
      setCreated(await backend.adminCreateCodes(count, label));
      await load();
    } catch (e) {
      toast.error(errorMessage(e, 'Could not create the codes.'));
    } finally {
      setCreating(false);
    }
  };

  const createdText = created ? created.join('\n') : '';

  return (
    <div className="page">
      <header className="spread">
        <div>
          <h1 className="h1 display">Admin</h1>
          <p className="muted">Who is using which access code, and control over each one.</p>
        </div>
        <Button variant="ghost" icon={<RefreshCw />} onClick={() => void load()}>
          Refresh
        </Button>
      </header>

      <section className="stats" aria-label="Code summary">
        <div className="stat">
          <div className="stat-number">{counts.in_use}</div>
          <div className="stat-label">in use</div>
        </div>
        <div className="stat">
          <div className="stat-number">{counts.unused}</div>
          <div className="stat-label">unused of {counts.total}</div>
        </div>
      </section>

      <Card className="stack">
        <h2 className="h2">Create codes</h2>
        <p className="small muted">New codes work on one device each. They are shown once, here: copy or download them before closing.</p>
        <div className="row-wrap">
          <label className="field" style={{ minWidth: 110 }}>
            <span className="label">How many</span>
            <input
              className="input"
              type="number"
              min={1}
              max={50}
              value={count}
              aria-label="How many codes"
              onChange={(e) => setCount(Math.max(1, Math.min(50, Math.floor(Number(e.target.value) || 1))))}
            />
          </label>
          <label className="field grow" style={{ minWidth: 160 }}>
            <span className="label">Label</span>
            <input className="input" value={label} maxLength={60} aria-label="Label for the new codes" onChange={(e) => setLabel(e.target.value)} />
          </label>
        </div>
        <div>
          <Button variant="primary" icon={<Plus />} loading={creating} onClick={() => void create()}>
            Create {count} code{count === 1 ? '' : 's'}
          </Button>
        </div>
        {created && (
          <div className="card card--soft stack" role="status">
            <div className="label">New codes (shown only now)</div>
            <textarea className="textarea mono" readOnly rows={Math.min(created.length, 8)} value={createdText} aria-label="New codes" />
            <div className="row-wrap">
              <Button
                variant="secondary"
                size="sm"
                icon={<Copy />}
                onClick={() =>
                  void copyText(createdText).then((ok) => toast[ok ? 'success' : 'error'](ok ? 'Codes copied.' : 'Copy is not available here. Select and copy them manually.'))
                }
              >
                Copy all
              </Button>
              <Button variant="secondary" size="sm" icon={<Download />} onClick={() => saveText(`${createdText}\n`, 'noteai-codes.txt')}>
                Download .txt
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setCreated(null)}>
                Hide
              </Button>
            </div>
          </div>
        )}
      </Card>

      <Card className="stack">
        <h2 className="h2">Codes</h2>
        <div className="row-wrap">
          <input
            className="input grow"
            type="search"
            placeholder="Search by label, name or email"
            aria-label="Search codes"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <Segmented<Filter>
          label="Filter codes"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: `All ${counts.total}` },
            { value: 'in_use', label: `In use ${counts.in_use}` },
            { value: 'unused', label: `Unused ${counts.unused}` },
            { value: 'revoked', label: `Revoked ${counts.revoked}` },
          ]}
        />
        {error && <Banner tone="danger">{error}</Banner>}
        {codes === null && !error && (
          <p className="muted row" role="status">
            <Spinner /> Loading…
          </p>
        )}
        {codes !== null && shown.length === 0 && <p className="muted">No codes match.</p>}
        <div className="stack" style={{ gap: 10 }}>
          {shown.map((code) => (
            <div key={code.id} className="card card--soft stack" style={{ gap: 8 }}>
              <div className="spread">
                <strong>{code.label ?? 'Code'}</strong>
                <span className="row" style={{ gap: 6 }}>
                  {code.isAdmin && <Badge tone="info">Admin</Badge>}
                  <Badge tone={STATUS_TONE[code.status]}>{STATUS_LABEL[code.status]}</Badge>
                </span>
              </div>
              {(code.ownerName || code.ownerEmail) && (
                <div className="small">
                  {code.ownerName} {code.ownerEmail && <span className="muted">· {code.ownerEmail}</span>}
                </div>
              )}
              <div className="tiny muted">
                {code.activatedAt ? `First used ${formatDateTime(code.activatedAt)}` : 'Never used'}
                {code.lastUsedAt ? ` · last ${formatDateTime(code.lastUsedAt)}` : ''} · up to {code.maxDevices} device{code.maxDevices === 1 ? '' : 's'}
              </div>
              {code.devices.map((device) => (
                <div key={device.deviceHash} className="spread small">
                  <span>
                    {device.label ?? 'Device'}
                    <span className="muted">
                      {device.fullName ? ` · ${device.fullName}` : ''}
                      {device.contactEmail ? ` · ${device.contactEmail}` : ''}
                    </span>
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<Unlink />}
                    aria-label={`Free the device ${device.label ?? ''} of ${code.label ?? 'this code'}`}
                    onClick={() => setPending({ kind: 'release', code, device })}
                  >
                    Free device
                  </Button>
                </div>
              ))}
              <div className="row-wrap">
                {code.status === 'revoked' ? (
                  <Button variant="secondary" size="sm" icon={<Undo2 />} onClick={() => setPending({ kind: 'restore', code })}>
                    Restore
                  </Button>
                ) : (
                  <Button variant="danger-soft" size="sm" icon={<ShieldOff />} onClick={() => setPending({ kind: 'revoke', code })}>
                    Revoke
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      </Card>

      {pending && (
        <ConfirmDialog
          title={pending.kind === 'revoke' ? 'Revoke this code?' : pending.kind === 'restore' ? 'Restore this code?' : 'Free this device?'}
          destructive={pending.kind !== 'restore'}
          busy={busy}
          confirmLabel={pending.kind === 'revoke' ? 'Revoke' : pending.kind === 'restore' ? 'Restore' : 'Free device'}
          message={
            pending.kind === 'revoke'
              ? `${pending.code.label ?? 'This code'} stops working: the device is signed out shortly and cannot sign in again until you restore the code. Recordings stored on that device are not touched.`
              : pending.kind === 'restore'
                ? `${pending.code.label ?? 'This code'} works again on the device that used it.`
                : `${pending.device.label ?? 'This device'} is removed from ${pending.code.label ?? 'the code'}, so the code can be used on a new device (the old one stays signed in until it signs out).`
          }
          onCancel={() => setPending(null)}
          onConfirm={() => void confirm()}
        />
      )}
    </div>
  );
}
