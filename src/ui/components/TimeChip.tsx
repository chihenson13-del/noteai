import { Play } from 'lucide-react';
import { formatTimestamp } from '../../lib/format';

/**
 * Evidence link: "▶ 04:12". Clicking plays the audio from that second. When no player is
 * available (audio deleted / not on this device) it renders as plain, non-interactive text.
 */
export function TimeChip({ atMs, onSeek, label }: { atMs: number | null; onSeek?: (ms: number) => void; label?: string }) {
  if (atMs === null) return null;
  const time = formatTimestamp(atMs);
  if (!onSeek) return <span className="time-chip time-chip--static">{time}</span>;
  return (
    <button type="button" className="time-chip" onClick={() => onSeek(atMs)} aria-label={`${label ?? 'Play'} from ${time}`}>
      <Play size={12} aria-hidden />
      {time}
    </button>
  );
}
