import { logHashKey, patientRef } from './patient-ref';

describe('patientRef', () => {
  const env = { ...process.env };

  afterEach(() => {
    process.env = { ...env };
  });

  it('gives the same ref for the same patient and never the id itself', () => {
    process.env.LOG_HASH_KEY = 'k1';

    expect(patientRef('p-1')).toBe(patientRef('p-1'));
    expect(patientRef('p-1')).not.toBe(patientRef('p-2'));
    expect(patientRef('p-1')).not.toContain('p-1');
  });

  it('changes with the key, so the ref cannot be rebuilt without it', () => {
    process.env.LOG_HASH_KEY = 'k1';
    const first = patientRef('p-1');
    process.env.LOG_HASH_KEY = 'k2';

    expect(patientRef('p-1')).not.toBe(first);
  });

  it('skips a patientId that is not a string', () => {
    process.env.LOG_HASH_KEY = 'k1';

    expect(patientRef(42)).toBeUndefined();
  });

  it('refuses to run without a key', () => {
    delete process.env.LOG_HASH_KEY;

    expect(() => logHashKey()).toThrow('LOG_HASH_KEY');
  });
});
