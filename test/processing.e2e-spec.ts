import { getModelToken } from '@nestjs/mongoose';
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { TestingModule } from '@nestjs/testing';
import { Model, Types } from 'mongoose';
import request from 'supertest';
import { Event } from '../src/events/schemas/event.schema';
import { ExternalInput } from '../src/processing/external-processor.service';
import {
  captureLogs,
  clearEvents,
  createApi,
  createWorker,
  eventsCollection,
  waitFor,
  WorkerOptions,
} from './helpers';

interface Call {
  patientId: string;
  ts: Date;
  data: Record<string, unknown>;
  idempotencyKey: string;
}

// Stands in for the external API: records order and concurrency of the calls.
class ExternalSpy {
  readonly calls: Call[] = [];
  maxSamePatient = 0;
  maxActive = 0;
  private readonly active = new Map<string, number>();
  // Each call waits on this; a test replaces it to hold calls until it says so.
  wait: () => Promise<void>;

  constructor(delayMs = 100) {
    this.wait = () => new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  async process(event: ExternalInput, idempotencyKey: string) {
    const { patientId, ts, data } = event;
    this.calls.push({ patientId, ts, data, idempotencyKey });
    const samePatient = (this.active.get(patientId) ?? 0) + 1;
    this.active.set(patientId, samePatient);
    this.maxSamePatient = Math.max(this.maxSamePatient, samePatient);
    this.maxActive = Math.max(
      this.maxActive,
      [...this.active.values()].reduce((a, b) => a + b, 0),
    );
    try {
      await this.wait();
      return { idempotencyKey };
    } finally {
      this.active.set(patientId, (this.active.get(patientId) ?? 1) - 1);
    }
  }
}

describe('Event processing (e2e)', () => {
  let api: NestFastifyApplication;
  let workers: TestingModule[];
  const events = () => eventsCollection(api);
  const model = () => api.get<Model<Event>>(getModelToken(Event.name));

  const startWorker = async (options: WorkerOptions = {}) => {
    const worker = await createWorker(options);
    workers.push(worker);
    return worker;
  };

  // Inserts through the model, like the api, so defaults (status, attempts, reprocessCount) apply.
  const seed = async (
    items: { patientId: string; ts: string; data?: object }[],
  ) => {
    const now = new Date();
    const docs = [];
    for (const [i, item] of items.entries()) {
      // One by one, so _id follows the list order.
      docs.push(
        await model().create({
          type: 'vitals',
          data: { i },
          ...item,
          dedupKey: `key-${i}`,
          receivedAt: now,
          availableAt: now,
        }),
      );
    }
    return docs;
  };

  const allDone = async (count: number) =>
    (await events().countDocuments({ status: 'done' })) === count;

  beforeAll(async () => {
    api = await createApi();
  });

  afterAll(async () => {
    await api.close();
  });

  beforeEach(async () => {
    workers = [];
    await clearEvents(api);
  });

  afterEach(async () => {
    await Promise.all(workers.map((worker) => worker.close()));
  });

  it('2.1 turns a posted event into done', async () => {
    await startWorker({ env: { PROCESSING_DELAY_MS: '100' } });

    const res = await request(api.getHttpServer())
      .post('/events')
      .send({
        patientId: 'p-1',
        type: 'vitals',
        data: { hr: 72 },
        ts: '2026-11-03T08:00:00Z',
      })
      .expect(202);

    const id = new Types.ObjectId((res.body as { id: string }).id);
    await waitFor(() => allDone(1));
    const doc = await events().findOne({ _id: id });
    expect(doc?.result).toEqual({
      type: 'vitals',
      idempotencyKey: `${doc?.dedupKey}:0`,
    });
    expect(doc?.processedAt).toBeInstanceOf(Date);
    expect(doc?.attempts).toBe(1);
    expect(doc?.leaseOwner).toBeUndefined();
    expect(doc?.leaseUntil).toBeUndefined();
  });

  it('2.2 sends dedupKey:0 as the idempotency key', async () => {
    const spy = new ExternalSpy();
    const [doc] = await seed([
      { patientId: 'p-1', ts: '2026-11-03T08:00:00Z' },
    ]);
    await startWorker({ external: spy });

    await waitFor(() => allDone(1));

    expect(spy.calls.map((c) => c.idempotencyKey)).toEqual([
      `${doc.dedupKey}:0`,
    ]);
  });

  it('2.3 processes one patient in ts order', async () => {
    const spy = new ExternalSpy(20);
    const minutes = [3, 1, 4, 0, 2];
    await seed(
      minutes.map((m) => ({
        patientId: 'p-1',
        ts: `2026-11-03T08:0${m}:00Z`,
      })),
    );
    await startWorker({ external: spy });

    await waitFor(() => allDone(5));

    expect(spy.calls.map((c) => c.ts.toISOString())).toEqual(
      [0, 1, 2, 3, 4].map((m) => `2026-11-03T08:0${m}:00.000Z`),
    );
  });

  it('2.4 breaks a ts tie by _id, one at a time', async () => {
    const spy = new ExternalSpy(50);
    const ts = '2026-11-03T08:00:00Z';
    await seed([
      { patientId: 'p-1', ts, data: { order: 'first' } },
      { patientId: 'p-1', ts, data: { order: 'second' } },
    ]);
    await startWorker({ external: spy });

    await waitFor(() => allDone(2));

    expect(spy.calls.map((c) => c.data.order)).toEqual(['first', 'second']);
    expect(spy.maxSamePatient).toBe(1);
  });

  it('2.5 never runs two events of one patient at once', async () => {
    const spy = new ExternalSpy(20);
    await seed(
      Array.from({ length: 20 }, (_, i) => ({
        patientId: 'p-1',
        ts: new Date(Date.UTC(2026, 10, 3, 8, 0, i)).toISOString(),
      })),
    );
    await startWorker({
      external: spy,
      env: { WORKER_CONCURRENCY: '10' },
    });

    await waitFor(() => allDone(20), 10_000);

    expect(spy.calls).toHaveLength(20);
    expect(spy.maxSamePatient).toBe(1);
  }, 15_000);

  it('2.6 runs different patients in parallel', async () => {
    const spy = new ExternalSpy(500);
    await seed(
      Array.from({ length: 10 }, (_, i) => ({
        patientId: `p-${i}`,
        ts: '2026-11-03T08:00:00Z',
      })),
    );
    await startWorker({
      external: spy,
      env: { WORKER_CONCURRENCY: '10' },
    });
    const start = Date.now();

    await waitFor(() => allDone(10));

    expect(Date.now() - start).toBeLessThan(1500);
    expect(spy.maxActive).toBe(10);
  });

  it('2.7 lets Mongo refuse a second processing event for a patient', async () => {
    const doc = (dedupKey: string) => ({
      dedupKey,
      patientId: 'p-1',
      type: 'vitals',
      data: {},
      ts: new Date(),
      receivedAt: new Date(),
      availableAt: new Date(),
      status: 'processing',
    });
    await events().insertOne(doc('a'));

    await expect(events().insertOne(doc('b'))).rejects.toMatchObject({
      code: 11000,
    });
  });

  it('claims a free patient queued behind 100 events of a busy patient', async () => {
    const busy = Array.from({ length: 101 }, (_, i) => ({
      patientId: 'p-1',
      ts: new Date(Date.UTC(2026, 10, 3, 8, 0, i)).toISOString(),
    }));
    const [head] = await seed([
      ...busy,
      { patientId: 'p-2', ts: '2026-11-03T09:00:00Z' },
    ]);
    // p-1 is busy in another worker, without a lease this worker could reap.
    await events().updateOne(
      { _id: head._id },
      { $set: { status: 'processing' } },
    );
    const spy = new ExternalSpy();
    await startWorker({ external: spy });

    await waitFor(() => spy.calls.some((c) => c.patientId === 'p-2'));
    expect(spy.calls.every((c) => c.patientId === 'p-2')).toBe(true);
  });

  it('2.8 does not complete an event whose lease moved to another worker', async () => {
    const spy = new ExternalSpy();
    let release!: () => void;
    spy.wait = () => new Promise((resolve) => (release = resolve));
    const [doc] = await seed([
      { patientId: 'p-1', ts: '2026-11-03T08:00:00Z' },
    ]);
    const worker = await startWorker({ external: spy });
    await waitFor(() => spy.calls.length === 1);

    await events().updateOne(
      { _id: doc._id },
      { $set: { leaseOwner: 'other-worker' } },
    );
    release();
    await worker.close();
    workers = [];

    const after = await events().findOne({ _id: doc._id });
    expect(after?.status).toBe('processing');
    expect(after?.leaseOwner).toBe('other-worker');
    expect(after?.result).toBeUndefined();
  });

  it('2.9 two workers process each event exactly once', async () => {
    const spy = new ExternalSpy(20);
    await seed(
      Array.from({ length: 50 }, (_, i) => ({
        patientId: `p-${i % 20}`,
        ts: new Date(Date.UTC(2026, 10, 3, 8, 0, i)).toISOString(),
      })),
    );
    await Promise.all([
      startWorker({ external: spy }),
      startWorker({ external: spy }),
    ]);

    await waitFor(() => allDone(50), 10_000);

    expect(spy.calls).toHaveLength(50);
    expect(new Set(spy.calls.map((c) => c.idempotencyKey)).size).toBe(50);
    expect(spy.maxSamePatient).toBe(1);
  }, 15_000);

  it('2.10 finishes the in-flight event before closing', async () => {
    const spy = new ExternalSpy(500);
    const [doc] = await seed([
      { patientId: 'p-1', ts: '2026-11-03T08:00:00Z' },
    ]);
    const worker = await startWorker({ external: spy });
    await waitFor(() => spy.calls.length === 1);

    await worker.close();
    workers = [];

    const after = await events().findOne({ _id: doc._id });
    expect(after?.status).toBe('done');
  });

  it('keeps a later event waiting while the head fails and is released', async () => {
    const order: string[] = [];
    let failures = 3;
    const external = {
      async process(event: ExternalInput) {
        const name = String(event.data.name);
        order.push(name);
        // The failure lands while the loop is between its head lookup and its claim (delayed below).
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (name === 'H1' && failures-- > 0) throw new Error('external down');
        return {};
      },
    };
    // Short backoff: the test is about order, not about the wait.
    const worker = await startWorker({ external, env: { RETRY_BASE_MS: '1' } });
    // Widens the race window: every claim write waits 50ms after the head lookup.
    const workerModel = worker.get<Model<Event>>(getModelToken(Event.name));
    const findOneAndUpdate = workerModel.findOneAndUpdate.bind(workerModel);
    jest.spyOn(workerModel, 'findOneAndUpdate').mockImplementation(((
      ...args: Parameters<typeof findOneAndUpdate>
    ) => ({
      lean: async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return findOneAndUpdate(...args).lean();
      },
    })) as unknown as typeof findOneAndUpdate);

    await seed([
      { patientId: 'p-1', ts: '2026-11-03T08:00:00Z', data: { name: 'H1' } },
      { patientId: 'p-1', ts: '2026-11-03T08:01:00Z', data: { name: 'H2' } },
    ]);
    await waitFor(() => allDone(2));

    expect(order).toEqual(['H1', 'H1', 'H1', 'H1', 'H2']);
  });

  it('2.11 logs one wide event per processed event', async () => {
    const logs = captureLogs();
    try {
      const [doc] = await seed([
        { patientId: 'p-1', ts: '2026-11-03T08:00:00Z' },
      ]);
      const worker = await startWorker({ external: new ExternalSpy() });
      await waitFor(() => allDone(1));
      await worker.close();
      workers = [];

      const lines = logs.wideEvents<Record<string, unknown>>();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toEqual({
        eventId: doc._id.toString(),
        patientId: 'p-1',
        attempt: 1,
        externalMs: expect.any(Number) as number,
        outcome: 'done',
      });
    } finally {
      logs.restore();
    }
  });
});
