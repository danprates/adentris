import { isExhausted, nextAttemptAt } from './retry-policy';

describe('retry policy', () => {
  it('doubles the wait on every attempt', () => {
    const now = new Date('2026-11-03T08:00:00Z');

    const waits = [1, 2, 3, 4].map(
      (attempts) =>
        nextAttemptAt(attempts, 1000, now).getTime() - now.getTime(),
    );

    expect(waits).toEqual([2000, 4000, 8000, 16_000]);
  });

  it('runs out on the fifth attempt', () => {
    expect(isExhausted(4)).toBe(false);
    expect(isExhausted(5)).toBe(true);
  });
});
