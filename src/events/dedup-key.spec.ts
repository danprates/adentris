import { DedupInput, dedupKey } from './dedup-key';

const base: DedupInput = {
  patientId: 'p-1',
  type: 'vitals',
  ts: new Date('2026-11-03T08:00:00Z'),
  data: { hr: 72, bp: { sys: 120, dia: 80 }, values: [1, 2] },
};

describe('dedupKey', () => {
  it('ignores object key order, including nested objects', () => {
    const reordered: DedupInput = {
      ...base,
      data: { values: [1, 2], bp: { dia: 80, sys: 120 }, hr: 72 },
    };
    expect(dedupKey(reordered)).toBe(dedupKey(base));
  });

  it('keeps array order meaningful', () => {
    const swapped: DedupInput = {
      ...base,
      data: { ...base.data, values: [2, 1] },
    };
    expect(dedupKey(swapped)).not.toBe(dedupKey(base));
  });

  it.each<[string, Partial<DedupInput>]>([
    ['patientId', { patientId: 'p-2' }],
    ['type', { type: 'labs' }],
    ['ts', { ts: new Date('2026-11-03T08:00:01Z') }],
    ['a data value', { data: { ...base.data, hr: 73 } }],
  ])('changes when %s changes', (_field, change) => {
    expect(dedupKey({ ...base, ...change })).not.toBe(dedupKey(base));
  });

  it('gives the same key for the same instant in different offsets', () => {
    const plusTwo = { ...base, ts: new Date('2026-11-03T10:00:00+02:00') };
    const utc = { ...base, ts: new Date('2026-11-03T08:00:00Z') };
    expect(dedupKey(plusTwo)).toBe(dedupKey(utc));
  });
});
