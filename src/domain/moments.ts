import type { Moment, MomentKind } from './types';

export const MOMENT_LABEL: Record<MomentKind, string> = {
  key: 'Key point',
  action: 'Action',
  question: 'Question',
  note: 'Note',
};

export const MOMENT_KINDS: MomentKind[] = ['key', 'action', 'question', 'note'];

/** Chronological order, stable for equal times. */
export function sortMoments(moments: Moment[]): Moment[] {
  return [...moments].sort((a, b) => a.atMs - b.atMs || a.id.localeCompare(b.id));
}

/** One line of text for exports and lists: "Action: Sam owns pricing". */
export function describeMoment(moment: Moment): string {
  const label = MOMENT_LABEL[moment.kind];
  return moment.text.trim() ? `${label}: ${moment.text.trim()}` : label;
}
