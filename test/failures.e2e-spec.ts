import { getModelToken } from '@nestjs/mongoose';
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { TestingModule } from '@nestjs/testing';
import { execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { Model } from 'mongoose';
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
  DAY,
} from './helpers';

// Short backoff (20ms, 40ms, 80ms, 160ms) and reaper period, so 5 attempts fit in a test.
const FAST = { RETRY_BASE_MS: '10', REAPER_INTERVAL_MS: '50' };

type Fails = (name: string, call: number) => boolean;

// Stands in for the external API: fails when `fails(name, nth call for that name)` says so.
function flakyExternal(fails: Fails, delayMs = 10) {
  const calls: { name: string; at: number }[] = [];
  return {
    calls,
    names: () => calls.map((c) => c.name),
    async process(event: ExternalInput, idempotencyKey: string) {
      const name = String(event.data.name);
      calls.push({ name, at: Date.now() });
      await sleep(delayMs);
      if (fails(name, calls.filter((c) => c.name === name).length)) {
        throw new Error('external down');
      }
      return { idempotencyKey };
    },
  };
}

describe('Failure handling (e2e)', () => {
  let api: NestFastifyApplication;
  let workers: TestingModule[];
  const events = () => eventsCollection(api);

  const startWorker = async (options: WorkerOptions = {}) => {
    const worker = await createWorker(options);
    workers.push(worker);
    return worker;
  };

  const closeWorker = async (worker: TestingModule) => {
    await worker.close();
    workers = workers.filter((w) => w !== worker);
  };

  // Raw insert, so a test can start from any state (processing, expired lease, attempts).
  let seq = 0;
  const insert = async (fields: Record<string, unknown> = {}) => {
    const now = new Date();
    const { insertedId } = await events().insertOne({
      dedupKey: `key-${seq++}`,
      patientId: 'p-1',
      type: 'vitals',
      data: { name: 'E1' },
      ts: new Date(`${DAY}T10:00:00Z`),
      receivedAt: now,
      availableAt: now,
      status: 'pending',
      attempts: 0,
      reprocessCount: 0,
      ...fields,
    });
    return insertedId;
  };

  const find = (name: string) => events().findOne({ 'data.name': name });
  const statusIs = async (name: string, status: string) =>
    (await find(name))?.status === status;

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

  it('3.1 fails once and then succeeds', async () => {
    const external = flakyExternal((_, call) => call === 1);
    await insert();
    await startWorker({ external, env: FAST });

    await waitFor(() => statusIs('E1', 'done'));

    const doc = await find('E1');
    expect(doc?.attempts).toBe(2);
    expect(doc?.error).toBeUndefined();
    expect(external.calls).toHaveLength(2);
  });

  it('3.2 gives up after five attempts when the API always fails', async () => {
    const external = flakyExternal(() => true);
    await insert();
    await startWorker({ external, env: FAST });

    await waitFor(() => statusIs('E1', 'failed'));

    const doc = await find('E1');
    expect(doc?.attempts).toBe(5);
    expect(doc?.error).toBe('external down');
    expect(doc?.leaseOwner).toBeUndefined();
    expect(external.calls).toHaveLength(5);
  });

  it('3.3 does not retry before availableAt', async () => {
    let failedAt = 0;
    const external = flakyExternal((_, call) => {
      if (call !== 1) return false;
      failedAt = Date.now();
      return true;
    });
    await insert();
    // Default backoff: the first retry waits 2s.
    await startWorker({ external });

    await waitFor(async () => (await find('E1'))?.error === 'external down');
    const retrying = await find('E1');
    expect(retrying?.status).toBe('pending');
    const availableAt = (retrying?.availableAt as Date).getTime();
    expect(availableAt - failedAt).toBeGreaterThanOrEqual(2000);
    expect(availableAt - failedAt).toBeLessThan(2500);

    await waitFor(() => statusIs('E1', 'done'));
    expect(external.calls[1].at).toBeGreaterThanOrEqual(availableAt);
  });

  it('3.4a holds the later events of a patient while the head waits for a retry', async () => {
    const external = flakyExternal((name, call) => name === 'E1' && call === 1);
    await insert({ data: { name: 'E1' } });
    await insert({
      data: { name: 'E2' },
      ts: new Date(`${DAY}T10:05:00Z`),
    });
    await startWorker({ external, env: FAST });

    await waitFor(() => statusIs('E2', 'done'));

    expect(external.names()).toEqual(['E1', 'E1', 'E2']);
  });

  it('3.4 does not block the patient after an event fails', async () => {
    const external = flakyExternal((name) => name === 'E1');
    await insert({ data: { name: 'E1' } });
    await insert({
      data: { name: 'E2' },
      ts: new Date(`${DAY}T10:05:00Z`),
    });
    await startWorker({ external, env: FAST });

    await waitFor(() => statusIs('E2', 'done'));

    expect((await find('E1'))?.status).toBe('failed');
    expect(external.names()).toEqual(['E1', 'E1', 'E1', 'E1', 'E1', 'E2']);
  });

  it('3.5 hands an event of a dead worker to a live one', async () => {
    const external = flakyExternal(() => false);
    await insert({
      status: 'processing',
      attempts: 1,
      leaseOwner: 'dead-worker',
      leaseUntil: new Date(Date.now() - 1000),
    });
    await startWorker({ external, env: FAST });

    await waitFor(() => statusIs('E1', 'done'));

    const doc = await find('E1');
    expect(doc?.attempts).toBe(2);
    expect(doc?.leaseOwner).toBeUndefined();
    expect(external.calls).toHaveLength(1);
  });

  it('3.6 leaves a lease that has not expired alone', async () => {
    const external = flakyExternal(() => false);
    await insert({
      status: 'processing',
      attempts: 1,
      leaseOwner: 'live-worker',
      leaseUntil: new Date(Date.now() + 60_000),
    });
    await startWorker({ external, env: FAST });

    // Several reaper periods.
    await sleep(300);

    const doc = await find('E1');
    expect(doc?.status).toBe('processing');
    expect(doc?.leaseOwner).toBe('live-worker');
    expect(external.calls).toHaveLength(0);
  });

  it('3.7 fails an event whose lease expired on the last attempt', async () => {
    const external = flakyExternal(() => false);
    await insert({
      status: 'processing',
      attempts: 5,
      leaseOwner: 'dead-worker',
      leaseUntil: new Date(Date.now() - 1000),
    });
    await startWorker({ external, env: FAST });

    await waitFor(() => statusIs('E1', 'failed'));

    const doc = await find('E1');
    expect(doc?.attempts).toBe(5);
    expect(doc?.error).toBe('lease expired');
    expect(doc?.leaseOwner).toBeUndefined();
    expect(external.calls).toHaveLength(0);
  });

  it('3.8 keeps the result of the worker that holds the lease', async () => {
    let release!: () => void;
    const slow = {
      async process() {
        await new Promise<void>((resolve) => (release = resolve));
        return { by: 'first' };
      },
    };
    const fast = { process: () => Promise.resolve({ by: 'second' }) };
    const id = await insert();
    // One slot: the first worker cannot claim the event again while its call hangs.
    const first = await startWorker({
      external: slow,
      env: { ...FAST, WORKER_CONCURRENCY: '1' },
    });
    await waitFor(() => statusIs('E1', 'processing'));

    // The lease runs out mid-call (a stalled process); the reaper hands the event to the second worker.
    await events().updateOne(
      { _id: id },
      { $set: { leaseUntil: new Date(Date.now() - 1000) } },
    );
    await startWorker({ external: fast, env: FAST });
    await waitFor(() => statusIs('E1', 'done'));
    release();
    await closeWorker(first);

    const doc = await find('E1');
    expect(doc?.status).toBe('done');
    expect(doc?.result).toEqual({ by: 'second' });
    expect(doc?.attempts).toBe(2);
  });

  it('refuses the write of a stale handle after the same worker claims the event again', async () => {
    const logs = captureLogs();
    try {
      const releases: (() => void)[] = [];
      const external = {
        async process() {
          const call = releases.length + 1;
          await new Promise<void>((resolve) => releases.push(resolve));
          return { call };
        },
      };
      const id = await insert();
      const worker = await startWorker({ external, env: FAST });
      await waitFor(() => releases.length === 1);

      // The lease runs out early (a stall); the reaper frees the event and this same worker claims it again.
      await events().updateOne(
        { _id: id },
        { $set: { leaseUntil: new Date(Date.now() - 1000) } },
      );
      await waitFor(() => releases.length === 2);
      releases[0]();
      await waitFor(() => logs.wideEvents().length === 1);

      const during = await find('E1');
      expect(during?.status).toBe('processing');
      expect(during?.attempts).toBe(2);
      expect(during?.result).toBeUndefined();

      releases[1]();
      await waitFor(() => statusIs('E1', 'done'));
      await closeWorker(worker);

      expect((await find('E1'))?.result).toEqual({ call: 2 });
      const lines = logs.wideEvents<Record<string, unknown>>();
      expect(lines.map((l) => [l.attempt, l.outcome])).toEqual([
        [1, 'lease_lost'],
        [2, 'done'],
      ]);
    } finally {
      logs.restore();
    }
  });

  it('leaves a failed completion write to the reaper instead of the retry policy', async () => {
    const logs = captureLogs();
    try {
      const external = flakyExternal(() => false);
      await insert();
      const worker = await startWorker({
        external,
        env: { ...FAST, EXTERNAL_TIMEOUT_MS: '200', LEASE_MS: '1000' },
      });
      const model = worker.get<Model<Event>>(getModelToken(Event.name));
      // The claim is a findOneAndUpdate, so the first updateOne is the done write.
      jest
        .spyOn(model, 'updateOne')
        .mockRejectedValueOnce(new Error('write down'));

      await waitFor(() => logs.wideEvents().length === 1);
      const stuck = await find('E1');
      expect(stuck?.status).toBe('processing');
      expect(stuck?.error).toBeUndefined();

      await waitFor(() => statusIs('E1', 'done'));
      await closeWorker(worker);

      expect((await find('E1'))?.attempts).toBe(2);
      const lines = logs.wideEvents<Record<string, unknown>>();
      expect(lines.map((l) => [l.attempt, l.outcome, l.writeError])).toEqual([
        [1, 'write_failed', 'write down'],
        [2, 'done', undefined],
      ]);
      expect(lines[0]).not.toHaveProperty('error');
    } finally {
      logs.restore();
    }
  });

  it('3.9 survives Mongo stalling for 3s and finishes the pending events', async () => {
    const external = flakyExternal(() => false, 200);
    for (let i = 0; i < 6; i++) {
      await insert({ patientId: `p-${i % 3}`, data: { name: `E${i}` } });
    }
    await startWorker({ external, env: FAST });
    await waitFor(() => external.calls.length > 0);

    execSync('docker compose pause mongo', { stdio: 'ignore' });
    try {
      await sleep(3000);
    } finally {
      execSync('docker compose unpause mongo', { stdio: 'ignore' });
    }

    await waitFor(
      async () => (await events().countDocuments({ status: 'done' })) === 6,
      15_000,
    );
  }, 30_000);

  it('3.10 logs a retry line and then a done line', async () => {
    const logs = captureLogs();
    try {
      const external = flakyExternal((_, call) => call === 1);
      const id = await insert();
      const worker = await startWorker({ external, env: FAST });
      await waitFor(() => statusIs('E1', 'done'));
      await closeWorker(worker);

      const lines = logs.wideEvents<Record<string, unknown>>();
      expect(lines).toEqual([
        expect.objectContaining({
          eventId: id.toString(),
          attempt: 1,
          outcome: 'retry',
          error: 'external down',
        }),
        expect.objectContaining({
          eventId: id.toString(),
          attempt: 2,
          outcome: 'done',
        }),
      ]);
      expect(lines[1]).not.toHaveProperty('error');
    } finally {
      logs.restore();
    }
  });

  it('3.11 times out a hung API call before the lease expires', async () => {
    const logs = captureLogs();
    try {
      let calls = 0;
      const external = {
        process: () =>
          ++calls === 1
            ? new Promise<Record<string, unknown>>(() => undefined)
            : Promise.resolve({}),
      };
      await insert();
      const worker = await startWorker({
        external,
        env: { ...FAST, EXTERNAL_TIMEOUT_MS: '200', LEASE_MS: '1000' },
      });
      await waitFor(() => statusIs('E1', 'done'));
      await closeWorker(worker);

      expect((await find('E1'))?.attempts).toBe(2);
      const lines = logs.wideEvents<Record<string, unknown>>();
      expect(lines.map((l) => l.outcome)).toEqual(['retry', 'done']);
      expect(lines[0].error).toMatch(/timeout/i);
      expect(lines[0].externalMs).toBeLessThan(1000);
      // The reaper logs every lease it releases; none means the lease never expired.
      expect(
        logs.lines().filter((l) => l.context === 'LeaseReaperService'),
      ).toEqual([]);
    } finally {
      logs.restore();
    }
  });

  it('answers a resent failed event as a duplicate and does not queue it again', async () => {
    const event = {
      patientId: 'p-1',
      type: 'vitals',
      data: { hr: 72 },
      ts: `${DAY}T10:00:00Z`,
    };
    await request(api.getHttpServer()).post('/events').send(event).expect(202);
    await events().updateMany({}, { $set: { status: 'failed', attempts: 5 } });

    const res = await request(api.getHttpServer())
      .post('/events')
      .send(event)
      .expect(200);

    expect(res.body).toMatchObject({ status: 'failed' });
    expect(await events().countDocuments({ status: 'failed' })).toBe(1);
    expect(await events().countDocuments()).toBe(1);
  });

  it('keeps the claim loop alive when Mongo stalls', async () => {
    const external = flakyExternal(() => false);
    await startWorker({ external });
    const logs = captureLogs();
    execSync('docker compose pause mongo', { stdio: 'ignore' });
    try {
      // Without a timeout the claim waits on the stalled socket and the loop never logs.
      await waitFor(
        () =>
          logs
            .lines()
            .some((line) => String(line.message).startsWith('claim failed')),
        10_000,
      );
    } finally {
      execSync('docker compose unpause mongo', { stdio: 'ignore' });
      logs.restore();
    }

    await insert();
    await waitFor(() => statusIs('E1', 'done'), 10_000);
  }, 30_000);
});
