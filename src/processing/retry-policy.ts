// 5 attempts with waits of 2s, 4s, 8s and 16s: a patient whose head keeps failing is held at most 30s,
// then the event turns failed. Trade-off: an external outage longer than ~30s fails the event.
export const MAX_ATTEMPTS = 5;

// `attempts` already counts the attempt that just failed (it is incremented at claim time).
export function nextAttemptAt(
  attempts: number,
  baseMs: number,
  now = new Date(),
): Date {
  return new Date(now.getTime() + baseMs * 2 ** attempts);
}

export function isExhausted(attempts: number): boolean {
  return attempts >= MAX_ATTEMPTS;
}
