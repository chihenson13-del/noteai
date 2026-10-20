import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../lib/errors';

// A controllable stand-in for the Supabase backend. Everything above it (auth store, device id,
// the sign-in screen and the shared validators) is the real code.
const signInWithCode = vi.fn();

vi.mock('../app/backend', () => ({
  backend: {
    getUser: async () => null,
    onAuthChange: () => () => undefined,
    signInWithCode: (...args: unknown[]) => signInWithCode(...args),
  },
}));

import { describeDevice, getDeviceId } from '../lib/deviceId';
import { AuthScreen } from './screens/AuthScreen';

function renderScreen() {
  return render(
    <MemoryRouter>
      <AuthScreen />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  signInWithCode.mockReset();
  localStorage.clear();
});

describe('device identity', () => {
  it('is stable across calls and survives in storage', () => {
    const first = getDeviceId();
    expect(first).toMatch(/^[A-Za-z0-9-]{16,64}$/);
    expect(getDeviceId()).toBe(first);
    expect(localStorage.getItem('noteai.deviceId')).toBe(first);
  });

  it('describes the browser coarsely', () => {
    expect(describeDevice('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36 Edg/120')).toBe('Edge on Windows');
    expect(describeDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit Version/17 Mobile Safari/604')).toBe('Safari on iOS');
    expect(describeDevice('Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0')).toBe('Firefox on Linux');
  });
});

describe('access-code sign-in', () => {
  it('formats the code as it is typed', async () => {
    const user = userEvent.setup();
    renderScreen();
    const input = screen.getByLabelText('Access code');
    await user.type(input, 'abcd1234efgh5678');
    expect(input).toHaveValue('ABCD-1234-EFGH-5678');
  });

  it('does not call the server for an incomplete code', async () => {
    const user = userEvent.setup();
    renderScreen();
    await user.type(screen.getByLabelText('Access code'), 'abcd-12');
    await user.click(screen.getByRole('button', { name: /sign in/i }));
    expect(screen.getByRole('alert')).toHaveTextContent(/4 digits/i);
    expect(signInWithCode).not.toHaveBeenCalled();
  });

  it('signs in with the code alone when the device is already known', async () => {
    signInWithCode.mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderScreen();
    await user.type(screen.getByLabelText('Access code'), 'abcd1234efgh5678');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => expect(signInWithCode).toHaveBeenCalledTimes(1));
    const [code, device, profile] = signInWithCode.mock.calls[0]!;
    expect(code).toBe('ABCD1234EFGH5678');
    expect(device).toMatchObject({ id: getDeviceId() });
    expect(typeof device.label).toBe('string');
    expect(profile).toBeUndefined();
    expect(screen.queryByLabelText('Full name')).not.toBeInTheDocument();
  });

  it('asks for full name and email on a device’s first login, then sends all three', async () => {
    signInWithCode
      .mockRejectedValueOnce(new AppError('PROFILE_REQUIRED', 'First time on this device.'))
      .mockResolvedValueOnce(undefined);
    const user = userEvent.setup();
    renderScreen();

    await user.type(screen.getByLabelText('Access code'), 'abcd1234efgh5678');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    // step 2: the code was accepted, so we now ask who is using it
    expect(await screen.findByLabelText('Full name')).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByText(/first time on this device/i, { selector: '.banner-title' })).toBeInTheDocument();
    expect(screen.getByLabelText('Access code')).toHaveAttribute('readonly');

    // both fields are required and validated before anything is sent
    await user.click(screen.getByRole('button', { name: /continue/i }));
    expect(screen.getByRole('alert')).toHaveTextContent(/full name/i);
    expect(signInWithCode).toHaveBeenCalledTimes(1);

    await user.type(screen.getByLabelText('Full name'), '  Ada   Lovelace ');
    await user.type(screen.getByLabelText('Email'), 'not-an-email');
    await user.click(screen.getByRole('button', { name: /continue/i }));
    expect(screen.getByRole('alert')).toHaveTextContent(/valid email/i);

    await user.clear(screen.getByLabelText('Email'));
    await user.type(screen.getByLabelText('Email'), 'Ada@Example.com');
    await user.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => expect(signInWithCode).toHaveBeenCalledTimes(2));
    const [code, , profile] = signInWithCode.mock.calls[1]!;
    expect(code).toBe('ABCD1234EFGH5678');
    expect(profile).toEqual({ fullName: 'Ada Lovelace', email: 'ada@example.com' });
  });

  it('shows the server’s reason when a code is bound to another device', async () => {
    signInWithCode.mockRejectedValue(new AppError('AUTH_REQUIRED', 'This code is already in use on another device. Each code works on one device.'));
    const user = userEvent.setup();
    renderScreen();
    await user.type(screen.getByLabelText('Access code'), 'abcd1234efgh5678');
    await user.click(screen.getByRole('button', { name: /sign in/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/already in use on another device/i);
    expect(screen.queryByLabelText('Full name')).not.toBeInTheDocument();
  });

  it('lets the user back out of the profile step to try another code', async () => {
    signInWithCode.mockRejectedValueOnce(new AppError('PROFILE_REQUIRED', 'First time.'));
    const user = userEvent.setup();
    renderScreen();
    await user.type(screen.getByLabelText('Access code'), 'abcd1234efgh5678');
    await user.click(screen.getByRole('button', { name: /sign in/i }));
    await screen.findByLabelText('Full name');

    await user.click(screen.getByRole('button', { name: /use a different code/i }));
    expect(screen.queryByLabelText('Full name')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Access code')).not.toHaveAttribute('readonly');
  });
});
