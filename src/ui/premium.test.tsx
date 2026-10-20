import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { INITIAL_RECORDER_STATE } from '../domain/recordingMachine';
import type { RecorderSnapshot } from '../recording/recorder';
import { useLibraryStore } from '../state/libraryStore';
import { useSettingsStore } from '../state/settingsStore';
import { DEFAULT_SETTINGS } from '../domain/types';
import { makeActionItem, makeNotes, makeRecording } from '../test/factories';
import { CaptureHealth } from './components/CaptureHealth';
import { LiveMoments } from './components/LiveMoments';
import { NotesPanel } from './components/NotesPanel';
import { TimeChip } from './components/TimeChip';
import { AskScreen } from './screens/AskScreen';
import { SharedNotesScreen } from './screens/SharedNotesScreen';
import { TrustScreen } from './screens/TrustScreen';

function snapshot(overrides: Partial<RecorderSnapshot> = {}): RecorderSnapshot {
  return {
    ...INITIAL_RECORDER_STATE,
    mimeType: null,
    quality: null,
    persistenceWarning: null,
    lastSavedAt: null,
    savedChunks: 0,
    micLabel: null,
    micMuted: false,
    moments: [],
    ...overrides,
  };
}

beforeEach(() => {
  useLibraryStore.setState({ recordings: [], transcriptIndex: new Map(), loaded: true, loadError: null });
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS }, loaded: true });
});

describe('TimeChip', () => {
  it('seeks when clickable and is plain text when no audio is available', async () => {
    const onSeek = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(<TimeChip atMs={72_000} onSeek={onSeek} label="Play source" />);
    await user.click(screen.getByRole('button', { name: /play source from 1:12/i }));
    expect(onSeek).toHaveBeenCalledWith(72_000);

    rerender(<TimeChip atMs={72_000} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText('1:12')).toBeInTheDocument();

    rerender(<TimeChip atMs={null} onSeek={onSeek} />);
    expect(screen.queryByText('1:12')).not.toBeInTheDocument();
  });
});

describe('CaptureHealth', () => {
  it('says "Not recording" when idle', () => {
    render(<CaptureHealth snapshot={snapshot()} subscribeLevel={null} now={1000} />);
    expect(screen.getByRole('status')).toHaveTextContent('Not recording');
  });

  it('shows measured facts while recording', () => {
    render(
      <CaptureHealth
        snapshot={snapshot({ phase: 'recording', savedChunks: 12, lastSavedAt: 99_200, micLabel: 'USB Mic' })}
        subscribeLevel={null}
        now={100_000}
      />,
    );
    expect(screen.getByText('USB Mic')).toBeInTheDocument();
    expect(screen.getByText('0.8 s ago')).toBeInTheDocument();
  });

  it('raises an alert when the microphone is muted or capture stopped', () => {
    const { rerender } = render(
      <CaptureHealth snapshot={snapshot({ phase: 'recording', micMuted: true, savedChunks: 3, lastSavedAt: 99_900 })} subscribeLevel={null} now={100_000} />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Needs attention');
    expect(screen.getByRole('alert')).toHaveTextContent(/muted/i);

    rerender(<CaptureHealth snapshot={snapshot({ phase: 'interrupted', savedChunks: 3 })} subscribeLevel={null} now={100_000} />);
    expect(screen.getByRole('status')).toHaveTextContent('Not capturing');
  });
});

describe('LiveMoments', () => {
  it('is disabled until a recording is live and explains how it works', () => {
    render(<LiveMoments snapshot={snapshot()} />);
    expect(screen.getByRole('button', { name: 'Key point' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add note' })).toBeDisabled();
    expect(screen.getByText(/mark something worth coming back to/i)).toBeInTheDocument();
  });

  it('lists the newest markers with their time', () => {
    render(
      <LiveMoments
        snapshot={snapshot({
          phase: 'recording',
          moments: [
            { id: 'a', atMs: 15_000, kind: 'key', text: 'Launch date' },
            { id: 'b', atMs: 65_000, kind: 'action', text: 'Sam owns pricing' },
          ],
        })}
      />,
    );
    expect(screen.getByText('1:05')).toBeInTheDocument();
    expect(screen.getByText(/Sam owns pricing/)).toBeInTheDocument();
    expect(screen.getByText('2 marked')).toBeInTheDocument();
  });
});

describe('NotesPanel evidence', () => {
  const notes = makeNotes({
    recordingId: 'rec-1',
    keyTakeaways: [{ text: 'Launch moves to May', atMs: 72_000 }],
    chapters: [{ title: 'Launch', startMs: 4000, endMs: 60_000, points: [{ text: 'Date moved', atMs: 5000 }] }],
  });
  const items = [makeActionItem({ text: 'Send recap', atMs: 61_000 })];
  const props = {
    recording: makeRecording('rec-1', { status: 'completed' }),
    notes,
    items,
    loading: false,
    canProcess: true,
    processing: false,
    onProcess: () => undefined,
    onRegenerate: () => undefined,
    onChanged: async () => undefined,
  };

  it('renders chapters and lets every evidence chip seek the audio', async () => {
    const onSeek = vi.fn();
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <NotesPanel {...props} onSeek={onSeek} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: 'Launch' })).toBeInTheDocument();
    expect(screen.getByText(/Tap a time to hear the source/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /play source from 1:12/i }));
    await user.click(screen.getByRole('button', { name: /play chapter from 0:04/i }));
    await user.click(screen.getAllByRole('button', { name: /play source from 0:05/i })[0]!);
    expect(onSeek.mock.calls.map((c) => c[0])).toEqual([72_000, 4000, 5000]);
  });

  it('degrades to plain times (no dead buttons) when the audio is gone', () => {
    render(
      <MemoryRouter>
        <NotesPanel {...props} />
      </MemoryRouter>,
    );
    expect(screen.queryByRole('button', { name: /play source/i })).not.toBeInTheDocument();
    expect(screen.getByText('1:12')).toBeInTheDocument();
  });

  it('offers PDF and Word exports and only shows Share link when sharing is possible', () => {
    const { rerender } = render(
      <MemoryRouter>
        <NotesPanel {...props} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('button', { name: 'PDF' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Word' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /share link/i })).not.toBeInTheDocument();

    rerender(
      <MemoryRouter>
        <NotesPanel {...props} onShare={() => undefined} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('button', { name: /share link/i })).toBeInTheDocument();
  });
});

describe('Ask', () => {
  it('searches on the device when no backend is configured, and says nothing is sent anywhere', () => {
    render(
      <MemoryRouter>
        <AskScreen />
      </MemoryRouter>,
    );
    expect(screen.getByRole('textbox', { name: /ask a question/i })).toBeInTheDocument();
    expect(screen.getByText(/runs on your device and nothing is sent anywhere/i)).toBeInTheDocument();
    expect(screen.getByText(/nothing to search yet/i)).toBeInTheDocument();
  });
});

describe('Trust center', () => {
  it('shows where recordings live and that nothing left a local-only deployment', () => {
    useLibraryStore.setState({
      recordings: [makeRecording('a'), makeRecording('b'), makeRecording('c', { inCloud: true, remotePath: 'u/c.webm' })],
    });
    render(
      <MemoryRouter>
        <TrustScreen />
      </MemoryRouter>,
    );
    expect(screen.getByText('only on this device').previousSibling).toHaveTextContent('2');
    expect(screen.getByText(/no cloud backend, so every recording stays in your browser/i)).toBeInTheDocument();
    // Without cloud processing there is never any cloud audio, so the button is not offered at all.
    expect(screen.queryByRole('button', { name: /delete all cloud audio/i })).not.toBeInTheDocument();
  });

  it('lets the user turn off the per-recording consent reminder', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <TrustScreen />
      </MemoryRouter>,
    );
    const toggle = screen.getByRole('switch', { name: /recording consent reminder/i });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    await user.click(toggle);
    await waitFor(() => expect(useSettingsStore.getState().settings.showRecordingReminder).toBe(false));
    expect(screen.getByRole('switch', { name: /recording consent reminder/i })).toHaveAttribute('aria-checked', 'false');
  });
});

describe('Shared notes page', () => {
  it('shows a neutral message when the link cannot be loaded', async () => {
    render(
      <MemoryRouter initialEntries={['/s/not-a-real-token']}>
        <Routes>
          <Route path="s/:token" element={<SharedNotesScreen />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { name: /notes unavailable/i })).toBeInTheDocument();
    expect(document.head.querySelector('meta[name="robots"]')?.getAttribute('content')).toMatch(/noindex/);
  });
});
