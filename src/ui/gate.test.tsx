import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { useAuthStore } from '../state/authStore';
import { RequireLogin } from './components/RequireLogin';

function renderGate(enabled: boolean) {
  return render(
    <MemoryRouter>
      <RequireLogin enabled={enabled}>
        <p>the app</p>
      </RequireLogin>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  useAuthStore.setState({ status: 'signedOut', user: null });
});

describe('RequireLogin (beta gate)', () => {
  it('shows only the sign-in screen when enabled and nobody is signed in', () => {
    renderGate(true);
    expect(screen.queryByText('the app')).not.toBeInTheDocument();
  });

  it('shows a loading state while the saved session is being read', () => {
    useAuthStore.setState({ status: 'loading' });
    renderGate(true);
    expect(screen.queryByText('the app')).not.toBeInTheDocument();
    expect(screen.getByRole('status', { name: /loading/i })).toBeInTheDocument();
  });

  it('opens the app once signed in', () => {
    useAuthStore.setState({ status: 'signedIn' });
    renderGate(true);
    expect(screen.getByText('the app')).toBeInTheDocument();
  });

  it('does nothing when the gate is off', () => {
    renderGate(false);
    expect(screen.getByText('the app')).toBeInTheDocument();
  });

  it('does nothing without a backend (status disabled)', () => {
    useAuthStore.setState({ status: 'disabled' });
    renderGate(true);
    expect(screen.getByText('the app')).toBeInTheDocument();
  });
});
