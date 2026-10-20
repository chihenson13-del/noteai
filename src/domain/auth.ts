import type { CloudUser } from '../data/backend';

/** What to call the signed-in person in the UI. Never shows the synthetic code-user address. */
export function displayName(user: CloudUser): string {
  if (user.name) return user.name;
  if (user.viaCode) return 'Access code user';
  return user.email ?? user.id;
}

/** First name for greetings, or null when we only have an opaque identity. */
export function greetingName(user: CloudUser): string | null {
  if (user.name) return user.name.split(' ')[0] ?? null;
  if (user.viaCode) return null;
  return user.email ? (user.email.split('@')[0] ?? null) : null;
}
