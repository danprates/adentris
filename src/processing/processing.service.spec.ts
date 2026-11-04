import { Model } from 'mongoose';
import { Event } from '../events/schemas/event.schema';
import { ExternalProcessorService } from './external-processor.service';
import { processingConfig } from './processing.config';
import { ProcessingService } from './processing.service';

// Mongoose query stub: chainable, resolves to `value` on lean().
const query = (value: unknown) => {
  const q = {
    sort: () => q,
    limit: () => q,
    lean: () => Promise.resolve(value),
  };
  return q;
};

describe('ProcessingService busy-patient list', () => {
  const start = new Date('2026-11-04T08:00:00Z');
  let distinct: jest.Mock;
  let find: jest.Mock;
  let service: ProcessingService;

  beforeEach(() => {
    jest.useFakeTimers({ now: start });
    distinct = jest.fn(() => Promise.resolve(['p1']));
    // An empty ready batch by default: claim() reads the busy list, finds nothing and returns null.
    find = jest.fn(() => query([]));
    service = new ProcessingService(
      {
        distinct,
        find,
        findOne: () =>
          query({ _id: 'e2', status: 'pending', availableAt: start }),
        findOneAndUpdate: () => query({ _id: 'e2', patientId: 'p2' }),
      } as unknown as Model<Event>,
      {} as ExternalProcessorService,
      processingConfig(),
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const excludedOnCall = (n: number): string[] => {
    const calls = find.mock.calls as [{ patientId: { $nin: string[] } }][];
    return calls[n][0].patientId.$nin;
  };

  it('reuses the list for claims within 200ms', async () => {
    await service.claim();
    jest.setSystemTime(start.getTime() + 199);
    await service.claim();

    expect(distinct).toHaveBeenCalledTimes(1);
  });

  it('reads the list again after 200ms', async () => {
    await service.claim();
    jest.setSystemTime(start.getTime() + 200);
    await service.claim();

    expect(distinct).toHaveBeenCalledTimes(2);
  });

  it('does not reuse a failed read', async () => {
    distinct.mockImplementationOnce(() =>
      Promise.reject(new Error('mongo down')),
    );
    await expect(service.claim()).rejects.toThrow('mongo down');
    await service.claim();

    expect(distinct).toHaveBeenCalledTimes(2);
  });

  it("adds this worker's own claim to the cached list", async () => {
    find.mockImplementationOnce(() => query([{ patientId: 'p2' }]));
    await expect(service.claim()).resolves.toMatchObject({ patientId: 'p2' });
    await service.claim();

    expect(distinct).toHaveBeenCalledTimes(1);
    expect(excludedOnCall(0)).toEqual(['p1']);
    expect(excludedOnCall(1)).toEqual(['p1', 'p2']);
  });
});
