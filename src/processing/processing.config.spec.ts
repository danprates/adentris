import { processingConfig } from './processing.config';

describe('processingConfig', () => {
  const env = { ...process.env };

  afterEach(() => {
    process.env = { ...env };
  });

  it('2.U8 refuses to boot when EXTERNAL_TIMEOUT_MS is not lower than LEASE_MS', () => {
    process.env.EXTERNAL_TIMEOUT_MS = '30000';
    process.env.LEASE_MS = '30000';

    expect(() => processingConfig()).toThrow(
      'EXTERNAL_TIMEOUT_MS (30000) must be lower than LEASE_MS (30000)',
    );
  });

  it('uses the planned defaults', () => {
    for (const name of [
      'WORKER_CONCURRENCY',
      'LEASE_MS',
      'EXTERNAL_TIMEOUT_MS',
      'PROCESSING_DELAY_MS',
      'RETRY_BASE_MS',
      'REAPER_INTERVAL_MS',
    ]) {
      delete process.env[name];
    }

    expect(processingConfig()).toEqual({
      concurrency: 500,
      leaseMs: 30_000,
      externalTimeoutMs: 10_000,
      processingDelayMs: 5_000,
      retryBaseMs: 1_000,
      reaperIntervalMs: 10_000,
    });
  });

  it('rejects a value that is not a positive integer', () => {
    process.env.WORKER_CONCURRENCY = 'abc';

    expect(() => processingConfig()).toThrow('WORKER_CONCURRENCY');
  });
});
