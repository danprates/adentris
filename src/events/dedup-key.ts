import { createHash } from 'node:crypto';

export interface DedupInput {
  patientId: string;
  type: string;
  ts: Date;
  data: Record<string, unknown>;
}

// The payload has no id, so the content is the key. Cost: identical events become one (also 2 equal readings in
// 1 s when ts has whole seconds), and a resend with one changed field (a send time) counts twice.
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
