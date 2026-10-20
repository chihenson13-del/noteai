import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { z } from 'zod';
import { Cloud, KeyRound } from 'lucide-react';
import { backend } from '../../app/backend';
import { env } from '../../config/env';
import { errorMessage, isAppError } from '../../lib/errors';
import {
  formatCodeInput,
  isWellFormedCode,
  normalizeCode,
  validateEmail,
  validateFullName,
} from '../../../supabase/functions/_shared/accessCode';
import { useAuthStore } from '../../state/authStore';
import { Banner, Button, Card, EmptyState, LinkButton, Segmented } from '../components/primitives';

type EmailMode = 'signin' | 'signup' | 'reset';
type Method = 'code' | 'email';

const emailSchema = z.string().trim().pipe(z.email('Enter a valid email address.'));
const passwordSchema = z.string().min(8, 'Use at least 8 characters.').max(128);

/**
 * Sign in with an access code (no account, no password) or, where enabled, with email.
 * Code login is two steps for a device's first login: the code is checked first, and only then
 * are the person's full name and email asked for (once per device).
 */
export function AuthScreen() {
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? '/';
  const status = useAuthStore((s) => s.status);
  const { signIn, signUp, sendPasswordReset, signInWithCode } = useAuthStore.getState();

  const methods = env.authMethods;
  const [method, setMethod] = useState<Method>(methods.includes('code') ? 'code' : 'email');

  // --- access code ---
  const [code, setCode] = useState('');
  const [needsProfile, setNeedsProfile] = useState(false);
  const [fullName, setFullName] = useState('');
  const [contactEmail, setContactEmail] = useState('');

  // --- email ---
  const [mode, setMode] = useState<EmailMode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (status === 'signedIn') navigate(from, { replace: true });
  }, [status, from, navigate]);

  if (!backend) {
    return (
      <div className="page">
        <EmptyState
          icon={<Cloud />}
          title="Accounts aren’t configured"
          action={
            <LinkButton to="/" variant="primary">
              Back home
            </LinkButton>
          }
        >
          This deployment runs in local-only mode: recordings stay in this browser. To enable sign-in, sync and AI processing, set
          the Supabase environment variables (see README).
        </EmptyState>
      </div>
    );
  }

  const resetMessages = () => {
    setError(null);
    setNotice(null);
  };

  const submitCode = async (event: React.FormEvent) => {
    event.preventDefault();
    resetMessages();

    if (!isWellFormedCode(normalizeCode(code))) {
      setError('Enter your access code (4 digits).');
      return;
    }
    let profile: { fullName: string; email: string } | undefined;
    if (needsProfile) {
      const name = validateFullName(fullName);
      if (!name.ok) return setError(name.error);
      const mail = validateEmail(contactEmail);
      if (!mail.ok) return setError(mail.error);
      profile = { fullName: name.value, email: mail.value };
    }

    setBusy(true);
    try {
      await signInWithCode(normalizeCode(code), profile);
    } catch (e) {
      if (isAppError(e) && e.code === 'PROFILE_REQUIRED') {
        // The code is valid and this device is new: ask who is using it, once.
        setNeedsProfile(true);
        setError(profile ? e.message : null);
        if (!profile) setNotice('Code accepted. Because this is the first time on this device, tell us who you are.');
      } else {
        setError(errorMessage(e));
      }
    } finally {
      setBusy(false);
    }
  };

  const submitEmail = async (event: React.FormEvent) => {
    event.preventDefault();
    resetMessages();

    const emailResult = emailSchema.safeParse(email);
    if (!emailResult.success) {
      setError(emailResult.error.issues[0]?.message ?? 'Enter a valid email address.');
      return;
    }
    if (mode !== 'reset') {
      const passwordResult = passwordSchema.safeParse(password);
      if (!passwordResult.success) {
        setError(passwordResult.error.issues[0]?.message ?? 'Invalid password.');
        return;
      }
    }

    setBusy(true);
    try {
      if (mode === 'signin') {
        await signIn(emailResult.data, password);
      } else if (mode === 'signup') {
        const result = await signUp(emailResult.data, password);
        if (result.needsEmailConfirmation) {
          setNotice('Almost done — check your inbox and click the confirmation link, then sign in.');
          setMode('signin');
        }
      } else {
        await sendPasswordReset(emailResult.data);
        setNotice('If an account exists for that email, a reset link is on its way.');
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const title =
    method === 'code'
      ? needsProfile
        ? 'Welcome — one quick step'
        : 'Enter your access code'
      : mode === 'signup'
        ? 'Create your account'
        : mode === 'reset'
          ? 'Reset password'
          : 'Welcome back';

  return (
    <div className="page" style={{ maxWidth: 480 }}>
      <header>
        <h1 className="h1 display">{title}</h1>
        <p className="muted">
          {method === 'code'
            ? 'No account or password needed. Each code works on one device.'
            : 'An account keeps your recordings, transcripts and notes private and in sync across devices.'}
        </p>
      </header>

      {methods.length > 1 && (
        <Segmented<Method>
          label="Sign-in method"
          value={method}
          onChange={(next) => {
            setMethod(next);
            resetMessages();
          }}
          options={[
            { value: 'code', label: 'Access code' },
            { value: 'email', label: 'Email' },
          ]}
        />
      )}

      {method === 'code' ? (
        <Card>
          <form className="stack" onSubmit={(e) => void submitCode(e)} noValidate>
            <div className="field">
              <label className="label" htmlFor="auth-code">
                Access code
              </label>
              <input
                id="auth-code"
                className="input mono"
                inputMode="text"
                autoCapitalize="characters"
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                placeholder="1234"
                value={code}
                readOnly={needsProfile}
                onChange={(e) => setCode(formatCodeInput(e.target.value))}
                aria-describedby="auth-code-hint"
              />
              <span id="auth-code-hint" className="hint">
                Your 4-digit code (the admin code is longer).{' '}
                {needsProfile && (
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => {
                      setNeedsProfile(false);
                      resetMessages();
                    }}
                  >
                    Use a different code
                  </button>
                )}
              </span>
            </div>

            {needsProfile && (
              <>
                <Banner tone="info" title="First time on this device">
                  We ask for your name and email once per device, so we know who is using this code. They are stored with the code
                  and are not used to sign you in. <Link to="/privacy">Read exactly what is stored</Link>.
                </Banner>
                <div className="field">
                  <label className="label" htmlFor="auth-fullname">
                    Full name
                  </label>
                  <input
                    id="auth-fullname"
                    className="input"
                    autoComplete="name"
                    value={fullName}
                    maxLength={100}
                    onChange={(e) => setFullName(e.target.value)}
                    required
                    data-autofocus
                  />
                </div>
                <div className="field">
                  <label className="label" htmlFor="auth-contact-email">
                    Email
                  </label>
                  <input
                    id="auth-contact-email"
                    className="input"
                    type="email"
                    inputMode="email"
                    autoComplete="email"
                    value={contactEmail}
                    onChange={(e) => setContactEmail(e.target.value)}
                    required
                  />
                </div>
              </>
            )}

            {error && (
              <Banner tone="danger" role="alert">
                {error}
              </Banner>
            )}
            {notice && <Banner tone="success">{notice}</Banner>}

            <Button type="submit" variant="primary" block loading={busy} icon={<KeyRound />}>
              {needsProfile ? 'Continue' : 'Sign in'}
            </Button>
          </form>
        </Card>
      ) : (
        <>
          <Segmented<EmailMode>
            label="Account action"
            value={mode}
            onChange={(next) => {
              setMode(next);
              resetMessages();
            }}
            options={[
              { value: 'signin', label: 'Sign in' },
              { value: 'signup', label: 'Sign up' },
              { value: 'reset', label: 'Reset' },
            ]}
          />
          <Card>
            <form className="stack" onSubmit={(e) => void submitEmail(e)} noValidate>
              <div className="field">
                <label className="label" htmlFor="auth-email">
                  Email
                </label>
                <input
                  id="auth-email"
                  className="input"
                  type="email"
                  autoComplete="email"
                  inputMode="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
              {mode !== 'reset' && (
                <div className="field">
                  <label className="label" htmlFor="auth-password">
                    Password
                  </label>
                  <input
                    id="auth-password"
                    className="input"
                    type="password"
                    autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    minLength={8}
                  />
                  {mode === 'signup' && <span className="hint">At least 8 characters.</span>}
                </div>
              )}
              {error && (
                <Banner tone="danger" role="alert">
                  {error}
                </Banner>
              )}
              {notice && <Banner tone="success">{notice}</Banner>}
              <Button type="submit" variant="primary" block loading={busy}>
                {mode === 'signin' ? 'Sign in' : mode === 'signup' ? 'Create account' : 'Send reset link'}
              </Button>
            </form>
          </Card>
        </>
      )}
    </div>
  );
}
