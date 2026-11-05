import { createHmac } from 'node:crypto';

// patientId is PHI, so logs carry a keyed hash: one patient's lines still match, and the id stays out.
// HMAC, not plain SHA-256: patient ids are often guessable, and a plain hash is reversed by trying them.
export function patientRef(patientId: unknown): string | undefined {
  if (typeof patientId !== 'string') return undefined;
  return createHmac('sha256', logHashKey())
    .update(patientId)
    .digest('hex')
    .slice(0, 16);
}

// Also called at boot, so a missing key stops the process instead of failing at the first log line.
export function logHashKey(): string {
  const key = process.env.LOG_HASH_KEY;
  if (!key)
    throw new Error('LOG_HASH_KEY is required to hash patientId in logs');
  return key;
}
