// 5 attempts, waits of 2s, 4s, 8s, 16s: a failing head holds its patient for 30s of waits plus 5 calls (up to
// 80s at the 10s timeout), then turns failed. Trade-off: an external outage longer than that fails the event.
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
