import { createHash } from 'node:crypto';

export interface DedupInput {
  patientId: string;
  type: string;
  ts: Date;
  data: Record<string, unknown>;
}

// The payload has no id, so the content is the key: two truly identical events become one.
// ts is serialized with toISOString() (UTC) and object keys are sorted; array order is kept.
export function dedupKey({ patientId, type, ts, data }: DedupInput): string {
  const canonical = JSON.stringify(
    { patientId, type, ts, data },
    (_key, value: unknown) =>
      value !== null && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(
            Object.entries(value).sort(([a], [b]) =>
              a < b ? -1 : a > b ? 1 : 0,
            ),
          )
        : value,
  );
  return createHash('sha256').update(canonical).digest('hex');
}
