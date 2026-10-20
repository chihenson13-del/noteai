import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminCode } from '../data/backend';
import { useAuthStore } from '../state/authStore';

const codes: AdminCode[] = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    label: 'Admin',
    status: 'in_use',
    isAdmin: true,
    maxDevices: 3,
    ownerName: 'Chi Henson',
    ownerEmail: 'chi@example.com',
    activatedAt: '2026-10-20T08:00:00Z',
    lastUsedAt: '2026-10-21T08:00:00Z',
    createdAt: '2026-10-20T00:00:00Z',
    devices: [],
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    label: 'Code 001',
    status: 'in_use',
    isAdmin: false,
    maxDevices: 1,
    ownerName: 'Ada Tester',
    ownerEmail: 'ada@example.com',
    activatedAt: '2026-10-20T09:00:00Z',
    lastUsedAt: null,
    createdAt: '2026-10-20T00:00:00Z',
    devices: [
      {
        deviceHash: 'a'.repeat(64),
        label: 'Chrome on Windows',
        fullName: 'Ada Tester',
        contactEmail: 'ada@example.com',
        firstSeenAt: '2026-10-20T09:00:00Z',
        lastSeenAt: '2026-10-20T09:30:00Z',
      },
    ],
  },
  {
    id: '33333333-3333-4333-8333-333333333333',
    label: 'Code 002',
    status: 'unused',
    isAdmin: false,
    maxDevices: 1,
    ownerName: null,
    ownerEmail: null,
    activatedAt: null,
    lastUsedAt: null,
    createdAt: '2026-10-20T00:00:00Z',
    devices: [],
  },
  {
    id: '44444444-4444-4444-8444-444444444444',
    label: 'Code 003',
    status: 'revoked',
    isAdmin: false,
    maxDevices: 1,
    ownerName: 'Bo Gone',
    ownerEmail: null,
    activatedAt: '2026-10-19T09:00:00Z',
    lastUsedAt: null,
    createdAt: '2026-10-20T00:00:00Z',
    devices: [],
  },
];

const fake = vi.hoisted(() => ({
  adminListCodes: vi.fn(),
  adminSetRevoked: vi.fn(),
  adminReleaseDevice: vi.fn(),
  adminCreateCodes: vi.fn(),
}));

vi.mock('../app/backend', () => ({ backend: fake }));

import { AdminScreen } from './screens/AdminScreen';

function renderAdmin() {
  return render(
    <MemoryRouter>
      <AdminScreen />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  fake.adminListCodes.mockResolvedValue(structuredClone(codes));
  fake.adminSetRevoked.mockResolvedValue(undefined);
  fake.adminReleaseDevice.mockResolvedValue(undefined);
  fake.adminCreateCodes.mockResolvedValue(['AAAA-BBBB-CCCC-DDDD', 'EEEE-FFFF-GGGG-HHHH']);
  useAuthStore.setState({ isAdmin: true });
});

describe('Admin screen', () => {
  it('is closed to people who did not sign in with an admin code', () => {
    useAuthStore.setState({ isAdmin: false });
    renderAdmin();
    expect(screen.getByRole('heading', { name: /admins only/i })).toBeInTheDocument();
    expect(fake.adminListCodes).not.toHaveBeenCalled();
  });

  it('lists codes with who uses them, and filters and searches', async () => {
    const user = userEvent.setup();
    renderAdmin();
    expect(await screen.findByText('Code 001')).toBeInTheDocument();
    expect(screen.getAllByText('Ada Tester').length).toBeGreaterThan(0);
    expect(screen.getByText('Chrome on Windows', { exact: false })).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /unused/i }));
    expect(screen.queryByText('Code 001')).not.toBeInTheDocument();
    expect(screen.getByText('Code 002')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /^all/i }));
    await user.type(screen.getByRole('searchbox', { name: /search codes/i }), 'bo gone');
    expect(screen.getByText('Code 003')).toBeInTheDocument();
    expect(screen.queryByText('Code 001')).not.toBeInTheDocument();
  });

  it('revokes a code only after confirming', async () => {
    const user = userEvent.setup();
    renderAdmin();
    const card = (await screen.findByText('Code 001')).closest('.card') as HTMLElement;
    await user.click(within(card).getByRole('button', { name: /^revoke$/i }));
    expect(fake.adminSetRevoked).not.toHaveBeenCalled();
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^revoke$/i }));
    await waitFor(() => expect(fake.adminSetRevoked).toHaveBeenCalledWith('22222222-2222-4222-8222-222222222222', true));
  });

  it('restores a revoked code and frees a device', async () => {
    const user = userEvent.setup();
    renderAdmin();
    const revoked = (await screen.findByText('Code 003')).closest('.card') as HTMLElement;
    await user.click(within(revoked).getByRole('button', { name: /restore/i }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^restore$/i }));
    await waitFor(() => expect(fake.adminSetRevoked).toHaveBeenCalledWith('44444444-4444-4444-8444-444444444444', false));

    const used = screen.getByText('Code 001').closest('.card') as HTMLElement;
    await user.click(within(used).getByRole('button', { name: /free the device/i }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: /free device/i }));
    await waitFor(() => expect(fake.adminReleaseDevice).toHaveBeenCalledWith('22222222-2222-4222-8222-222222222222', 'a'.repeat(64)));
  });

  it('creates codes and shows them once', async () => {
    const user = userEvent.setup();
    renderAdmin();
    await screen.findByText('Code 001');
    fireEvent.change(screen.getByRole('spinbutton', { name: /how many codes/i }), { target: { value: '2' } });
    await user.click(screen.getByRole('button', { name: /create 2 codes/i }));
    await waitFor(() => expect(fake.adminCreateCodes).toHaveBeenCalledWith(2, 'Beta'));
    expect(await screen.findByDisplayValue(/AAAA-BBBB-CCCC-DDDD/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /download \.txt/i })).toBeInTheDocument();
  });
});
