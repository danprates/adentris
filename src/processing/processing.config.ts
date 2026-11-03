import { registerAs } from '@nestjs/config';

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return value;
}

export const processingConfig = registerAs('processing', () => {
  const config = {
    concurrency: positiveInt('WORKER_CONCURRENCY', 500),
    leaseMs: positiveInt('LEASE_MS', 30_000),
    externalTimeoutMs: positiveInt('EXTERNAL_TIMEOUT_MS', 10_000),
    processingDelayMs: positiveInt('PROCESSING_DELAY_MS', 5_000),
    // Wait before attempt n+1 is retryBaseMs * 2^n: 1000 gives 2s, 4s, 8s, 16s.
    retryBaseMs: positiveInt('RETRY_BASE_MS', 1_000),
  };
  // A call still running when its lease expires lets a second worker process the same event.
  if (config.externalTimeoutMs >= config.leaseMs) {
    throw new Error(
      `EXTERNAL_TIMEOUT_MS (${config.externalTimeoutMs}) must be lower than LEASE_MS (${config.leaseMs})`,
    );
  }
  return config;
});
