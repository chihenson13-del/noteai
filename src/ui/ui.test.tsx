import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { localStore } from '../app/localStore';
import type { ActionItem, Notes } from '../domain/types';
import { makeRecording } from '../test/factories';
import { useLibraryStore } from '../state/libraryStore';
import { NotesPanel } from './components/NotesPanel';
import { TranscriptPanel } from './components/TranscriptPanel';
import { Modal } from './components/Modal';
import { DashboardScreen } from './screens/DashboardScreen';
import { RecordScreen } from './screens/RecordScreen';

const notes: Notes = {
  recordingId: 'rec-1',
  summary: 'We agreed on the roadmap.',
  keyTakeaways: [{ text: 'Roadmap agreed', atMs: 12_000 }],
  decisions: [{ text: 'Ship in May', atMs: null }],
  chapters: [{ title: 'Roadmap', startMs: 0, endMs: null, points: [{ text: 'Q2 focus', atMs: 30_000 }] }],
  topics: [],
  provider: 'anthropic',
  model: 'test-model',
  userEdited: false,
  createdAt: '',
  updatedAt: '',
};

const items: ActionItem[] = [
  { id: 'a1', recordingId: 'rec-1', text: 'Send the recap', assignee: 'Sam', dueDate: null, done: false, sortOrder: 0, atMs: null },
];

beforeEach(() => {
  useLibraryStore.setState({ recordings: [], transcriptIndex: new Map(), loaded: true, loadError: null });
});

describe('Dashboard', () => {
  it('shows the empty state and a working start button for new users', () => {
    render(
      <MemoryRouter>
        <DashboardScreen />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: /start recording/i })).toHaveAttribute('href', '/record');
    expect(screen.getByText(/your first recording starts here/i)).toBeInTheDocument();
    // no backend configured in tests: the local-only mode is stated, not hidden
    expect(screen.getByText(/running in local-only mode/i)).toBeInTheDocument();
  });

  it('lists recent recordings and filters them by search text', async () => {
    useLibraryStore.setState({
      recordings: [makeRecording({ title: 'Quarterly planning' }), makeRecording({ id: 'rec-2', title: 'Customer interview' })],
      transcriptIndex: new Map([['rec-2', 'they asked about invoices']]),
    });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <DashboardScreen />
      </MemoryRouter>,
    );
    expect(screen.getByText('Quarterly planning')).toBeInTheDocument();
    expect(screen.getByText('Customer interview')).toBeInTheDocument();

    await user.type(screen.getByRole('searchbox', { name: /search recordings/i }), 'invoices');
    expect(screen.queryByText('Quarterly planning')).not.toBeInTheDocument();
    expect(screen.getByText('Customer interview')).toBeInTheDocument();

    await user.clear(screen.getByRole('searchbox', { name: /search recordings/i }));
    await user.type(screen.getByRole('searchbox', { name: /search recordings/i }), 'zzzz');
    expect(screen.getByText(/no matches/i)).toBeInTheDocument();
  });
});

describe('Record screen', () => {
  it('explains clearly when the browser cannot record and does not offer a working start', () => {
    render(
      <MemoryRouter>
        <RecordScreen />
      </MemoryRouter>,
    );
    expect(screen.getByText(/can’t record audio/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /start recording/i })).toBeDisabled();
    expect(screen.getByText(/keep this tab open and your screen on/i)).toBeInTheDocument();
    expect(screen.getAllByRole('status').some((el) => /ready/i.test(el.textContent ?? ''))).toBe(true);
  });
});

describe('Notes panel', () => {
  it('shows an honest empty state when processing is unavailable', () => {
    render(
      <MemoryRouter>
        <NotesPanel
          recording={makeRecording()}
          notes={null}
          items={[]}
          loading={false}
          canProcess={false}
          processing={false}
          onProcess={() => undefined}
          onRegenerate={() => undefined}
          onChanged={async () => undefined}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText(/no notes yet/i)).toBeInTheDocument();
    expect(screen.getByText(/can.t transcribe on the device/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /transcribe/i })).not.toBeInTheDocument();
  });

  it('labels AI output, and lets the user edit and save it', async () => {
    const onChanged = vi.fn(async () => undefined);
    const user = userEvent.setup();
    await localStore.putRecording(makeRecording());
    render(
      <MemoryRouter>
        <NotesPanel
          recording={makeRecording()}
          notes={notes}
          items={items}
          loading={false}
          canProcess
          processing={false}
          onProcess={() => undefined}
          onRegenerate={() => undefined}
          onChanged={onChanged}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText(/AI-generated by anthropic \(test-model\)/i)).toBeInTheDocument();
    expect(screen.getByText('Roadmap agreed')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^edit$/i }));
    const summary = screen.getByRole('textbox', { name: /^summary$/i });
    await user.clear(summary);
    await user.type(summary, 'Edited summary.');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(async () => {
      const stored = await localStore.getNotes('rec-1');
      expect(stored?.summary).toBe('Edited summary.');
      expect(stored?.userEdited).toBe(true);
    });
    expect(onChanged).toHaveBeenCalled();
  });

  it('toggles action items and persists the change', async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn(async () => undefined);
    render(
      <MemoryRouter>
        <NotesPanel
          recording={makeRecording()}
          notes={notes}
          items={items}
          loading={false}
          canProcess
          processing={false}
          onProcess={() => undefined}
          onRegenerate={() => undefined}
          onChanged={onChanged}
        />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole('checkbox', { name: /mark “send the recap” as done/i }));
    await waitFor(async () => {
      expect((await localStore.listActionItems('rec-1'))[0]?.done).toBe(true);
    });
  });
});

describe('Transcript panel', () => {
  const transcript = {
    recordingId: 'rec-1',
    language: 'en',
    text: 'Hello team. Budget is fine.',
    segments: [
      { startMs: 0, endMs: 2000, text: 'Hello team.' },
      { startMs: 2000, endMs: 5000, text: 'Budget is fine.' },
    ],
    provider: 'openai',
    model: 'whisper-1',
    createdAt: '',
  };

  it('searches within the transcript and seeks when a timestamp is clicked', async () => {
    const onSeek = vi.fn();
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <TranscriptPanel
          recording={makeRecording({ status: 'completed' })}
          transcript={transcript}
          loading={false}
          canProcess
          processing={false}
          onProcess={() => undefined}
          onSeek={onSeek}
        />
      </MemoryRouter>,
    );
    await user.type(screen.getByRole('searchbox', { name: /search in transcript/i }), 'budget');
    expect(screen.getByText('1 match')).toBeInTheDocument();
    expect(document.querySelector('mark')?.textContent?.toLowerCase()).toBe('budget');

    await user.click(screen.getByRole('button', { name: /play from 0:02/i }));
    expect(onSeek).toHaveBeenCalledWith(2000);
  });

  it('offers a retry that keeps the original recording when transcription failed', async () => {
    const onProcess = vi.fn();
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <TranscriptPanel
          recording={makeRecording({ status: 'failed', failedStage: 'transcribe', errorMessage: 'Provider unavailable' })}
          transcript={null}
          loading={false}
          canProcess
          processing={false}
          onProcess={onProcess}
          onSeek={() => undefined}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText(/provider unavailable/i)).toBeInTheDocument();
    expect(screen.getByText(/original recording is untouched/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /retry transcription/i }));
    expect(onProcess).toHaveBeenCalledTimes(1);
  });
});

describe('Modal', () => {
  it('closes on Escape and traps focus inside', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <Modal title="Confirm" onClose={onClose} actions={<button>OK</button>}>
        <input aria-label="first" />
      </Modal>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Confirm' });
    expect(within(dialog).getByLabelText('first')).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });
});
