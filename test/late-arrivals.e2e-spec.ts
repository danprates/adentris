import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { TestingModule } from '@nestjs/testing';
import { setTimeout as sleep } from 'node:timers/promises';
import request from 'supertest';
import { ExternalInput } from '../src/processing/external-processor.service';
import {
  captureLogs,
  clearEvents,
  createApi,
  createWorker,
  eventsCollection,
  onDay,
  waitFor,
  WorkerOptions,
} from './helpers';

// Short backoff, so a retry fits in a test.
const FAST = { RETRY_BASE_MS: '10' };

interface SpyOptions {
  // Fails the nth call (1-based) for that event name when it returns true.
  fails?: (name: string, call: number) => boolean;
  // Holds the nth call for that event name until the returned promise settles.
  hold?: (name: string, call: number) => Promise<void> | undefined;
}

// Stands in for the external API: records the order of the calls and their idempotency keys.
function spyExternal({
  fails = () => false,
  hold = () => undefined,
}: SpyOptions = {}) {
  const calls: { name: string; key: string }[] = [];
  return {
    calls,
    names: () => calls.map((c) => c.name),
    keys: (name: string) =>
      calls.filter((c) => c.name === name).map((c) => c.key),
    async process(event: ExternalInput, idempotencyKey: string) {
      const name = String(event.data.name);
      calls.push({ name, key: idempotencyKey });
      const call = calls.filter((c) => c.name === name).length;
      await (hold(name, call) ?? sleep(10));
      if (fails(name, call)) throw new Error('external down');
      return { idempotencyKey };
    },
  };
}

// 10:00 plus `minute` minutes on the test day.
const at = (minute: number) => onDay('10:00:00', minute * 60_000);

describe('Late arrivals (e2e)', () => {
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

  // Sends an event through the api, like a real sender.
  const post = (name: string, minute: number, patientId = 'p-1') =>
    request(api.getHttpServer())
      .post('/events')
      .send({
        patientId,
        type: 'vitals',
        data: { name },
        ts: at(minute).toISOString(),
      });

  // Raw insert, so a test can start from any state (done, failed, a half-done reset).
  let seq = 0;
  const insert = (name: string, minute: number, fields = {}) => {
    const now = new Date();
    return events().insertOne({
      dedupKey: `raw-${seq++}`,
      patientId: 'p-1',
      type: 'vitals',
      data: { name },
      ts: at(minute),
      receivedAt: now,
      availableAt: now,
      status: 'pending',
      attempts: 0,
      reprocessCount: 0,
      ...fields,
    });
  };

  const find = (name: string) => events().findOne({ 'data.name': name });
  const isDone = async (name: string, reprocessCount = 0) => {
    const doc = await find(name);
    return doc?.status === 'done' && doc.reprocessCount === reprocessCount;
  };
  const allDone = async (...names: string[]) =>
    (await Promise.all(names.map((name) => isDone(name)))).every(Boolean);

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

  it('reprocesses the later events when a late event arrives', async () => {
    const external = spyExternal();
    await startWorker({ external });
    await post('E2', 5).expect(202);
    await post('E3', 10).expect(202);
    await waitFor(() => allDone('E2', 'E3'));

    await post('E1', 0).expect(202);
    await waitFor(async () => (await isDone('E2', 1)) && isDone('E3', 1));

    expect(external.names()).toEqual(['E2', 'E3', 'E1', 'E2', 'E3']);
    expect(await isDone('E1')).toBe(true);
  });

  it('does not reprocess anything for a newer event', async () => {
    const external = spyExternal();
    await startWorker({ external });
    await post('E1', 0).expect(202);
    await post('E2', 5).expect(202);
    await waitFor(() => allDone('E1', 'E2'));

    await post('E3', 10).expect(202);
    await waitFor(() => allDone('E1', 'E2', 'E3'));

    expect(external.names()).toEqual(['E1', 'E2', 'E3']);
    expect(await events().countDocuments({ reprocessCount: { $gt: 0 } })).toBe(
      0,
    );
  });

  it('does not count an equal ts as late', async () => {
    const external = spyExternal();
    await startWorker({ external });
    await post('E1', 0).expect(202);
    await waitFor(() => allDone('E1'));

    await post('E1b', 0).expect(202);
    await waitFor(() => allDone('E1', 'E1b'));

    expect(external.names()).toEqual(['E1', 'E1b']);
  });

  it('makes a late event wait while the patient is busy', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const external = spyExternal({
      hold: (name, call) => (name === 'E2' && call === 1 ? gate : undefined),
    });
    await startWorker({ external });
    await post('E2', 5).expect(202);
    await waitFor(async () => (await find('E2'))?.status === 'processing');

    await post('E1', 0).expect(202);
    await sleep(200);
    expect(external.names()).toEqual(['E2']);
    release();
    await waitFor(async () => (await isDone('E2', 1)) && isDone('E1'));

    expect(external.names()).toEqual(['E2', 'E1', 'E2']);
  });

  it('reprocesses once for two late events that arrive together', async () => {
    const external = spyExternal();
    const worker = await startWorker({ external });
    await post('E3', 10).expect(202);
    await waitFor(() => allDone('E3'));
    // Stopped worker: both late events are queued before either is claimed.
    await closeWorker(worker);

    await post('E1', 0).expect(202);
    await post('E2', 5).expect(202);
    await startWorker({ external });
    await waitFor(async () => (await allDone('E1', 'E2')) && isDone('E3', 1));

    expect(external.names()).toEqual(['E3', 'E1', 'E2', 'E3']);
  });

  it('reprocesses again for each late event in sequence', async () => {
    const external = spyExternal();
    await startWorker({ external });
    await post('E3', 10).expect(202);
    await waitFor(() => allDone('E3'));
    await post('E2', 5).expect(202);
    await waitFor(async () => (await allDone('E2')) && isDone('E3', 1));

    await post('E1', 0).expect(202);
    await waitFor(
      async () =>
        (await allDone('E1')) && (await isDone('E2', 1)) && isDone('E3', 2),
    );

    expect(external.names()).toEqual(['E3', 'E2', 'E3', 'E1', 'E2', 'E3']);
    const processed = await events()
      .find({}, { sort: { processedAt: 1 } })
      .toArray();
    expect(processed.map((doc) => (doc.data as { name: string }).name)).toEqual(
      ['E1', 'E2', 'E3'],
    );
  });

  it('reprocesses only the late event patient', async () => {
    const external = spyExternal();
    await startWorker({ external });
    await post('E2', 5).expect(202);
    await post('E9', 30, 'p-2').expect(202);
    await waitFor(() => allDone('E2', 'E9'));

    await post('E1', 0).expect(202);
    await waitFor(async () => (await allDone('E1')) && isDone('E2', 1));

    expect(external.names().filter((name) => name === 'E9')).toHaveLength(1);
    expect(await isDone('E9')).toBe(true);
  });

  it('reprocesses every later event of a very old late event, in ts order', async () => {
    const external = spyExternal();
    await startWorker({ external });
    const later = Array.from({ length: 50 }, (_, i) => `L${i + 1}`);
    for (const [i, name] of later.entries()) {
      await post(name, i + 1).expect(202);
    }
    await waitFor(
      async () => (await events().countDocuments({ status: 'done' })) === 50,
      10_000,
    );

    await post('E0', 0).expect(202);
    await waitFor(
      async () =>
        (await events().countDocuments({
          status: 'done',
          reprocessCount: 1,
        })) === 50,
      10_000,
    );

    expect(external.names().slice(50)).toEqual(['E0', ...later]);
    expect(await isDone('E0')).toBe(true);
  }, 30_000);

  it('leaves a later failed event alone', async () => {
    const external = spyExternal();
    await insert('E2', 5, { status: 'failed', attempts: 5, error: 'boom' });
    await startWorker({ external });
    await post('E3', 10).expect(202);
    await waitFor(() => allDone('E3'));

    await post('E1', 0).expect(202);
    await waitFor(async () => (await allDone('E1')) && isDone('E3', 1));

    expect(external.names()).toEqual(['E3', 'E1', 'E3']);
    const failed = await find('E2');
    expect(failed?.status).toBe('failed');
    expect(failed?.reprocessCount).toBe(0);
  });

  it('does not reprocess for a duplicate of an old event', async () => {
    const external = spyExternal();
    await startWorker({ external });
    await post('E1', 0).expect(202);
    await post('E2', 5).expect(202);
    await waitFor(() => allDone('E1', 'E2'));

    await post('E1', 0).expect(200);
    await sleep(200);

    expect(external.names()).toEqual(['E1', 'E2']);
    expect(await allDone('E1', 'E2')).toBe(true);
    expect(await events().countDocuments()).toBe(2);
  });

  it('does not repeat the reset when the late event retries', async () => {
    const external = spyExternal({
      fails: (name, call) => name === 'E1' && call === 1,
    });
    await startWorker({ external, env: FAST });
    await post('E2', 5).expect(202);
    await waitFor(() => allDone('E2'));

    await post('E1', 0).expect(202);
    await waitFor(async () => (await allDone('E1')) && isDone('E2', 1));

    expect(external.names()).toEqual(['E2', 'E1', 'E1', 'E2']);
    expect((await find('E1'))?.attempts).toBe(2);
  });

  it('finishes a reset cut short by a crash', async () => {
    const external = spyExternal();
    // The worker died mid-updateMany: E2 went back to pending, E3 is still done.
    await insert('E1', 0);
    await insert('E2', 5, { reprocessCount: 1, attempts: 0 });
    await insert('E3', 10, { status: 'done', attempts: 1 });
    await startWorker({ external });

    await waitFor(
      async () =>
        (await allDone('E1')) && (await isDone('E2', 1)) && isDone('E3', 1),
    );

    expect(external.names()).toEqual(['E1', 'E2', 'E3']);
  });

  it('treats a failed event put back in the queue as late', async () => {
    const external = spyExternal();
    await insert('E1', 0, { status: 'failed', attempts: 5, error: 'boom' });
    await insert('E2', 5, { status: 'done', attempts: 1 });
    await startWorker({ external });
    await sleep(200);
    expect(external.calls).toHaveLength(0);

    // What an operator does to retry a failed event.
    await events().updateOne(
      { 'data.name': 'E1' },
      { $set: { status: 'pending', attempts: 0, availableAt: new Date() } },
    );
    await waitFor(async () => (await allDone('E1')) && isDone('E2', 1));

    expect(external.names()).toEqual(['E1', 'E2']);
  });

  it('marks the wide event of a late event', async () => {
    const logs = captureLogs();
    try {
      const external = spyExternal();
      const worker = await startWorker({ external });
      await post('E2', 5).expect(202);
      await waitFor(() => allDone('E2'));

      await post('E1', 0).expect(202);
      await waitFor(async () => (await allDone('E1')) && isDone('E2', 1));
      await closeWorker(worker);

      const late = await find('E1');
      // The api logs its own wide events too; only the worker lines have an outcome.
      const lines = logs
        .wideEvents<Record<string, unknown>>()
        .filter((line) => 'outcome' in line);
      expect(lines).toHaveLength(3);
      for (const line of lines) {
        if (line.eventId === late?._id.toString()) {
          expect(line).toMatchObject({ late: true, reprocessed: 1 });
        } else {
          expect(line).not.toHaveProperty('late');
          expect(line).not.toHaveProperty('reprocessed');
        }
      }
    } finally {
      logs.restore();
    }
  });

  it('reprocesses with a new idempotency key and keeps one document', async () => {
    const external = spyExternal();
    await startWorker({ external });
    await post('E2', 5).expect(202);
    await waitFor(() => allDone('E2'));
    const { dedupKey } = (await find('E2'))!;

    await post('E1', 0).expect(202);
    await waitFor(async () => (await allDone('E1')) && isDone('E2', 1));

    expect(external.keys('E2')).toEqual([`${dedupKey}:0`, `${dedupKey}:1`]);
    expect(await events().countDocuments({ 'data.name': 'E2' })).toBe(1);
    expect((await find('E2'))?.result).toEqual({
      idempotencyKey: `${dedupKey}:1`,
    });
  });

  it('gives a reprocessed event its full retries, not the attempts of its earlier run', async () => {
    // E2 needed 4 attempts the first time; its reprocess fails twice and then succeeds.
    const external = spyExternal({
      fails: (name, call) => name === 'E2' && call <= 2,
    });
    await insert('E2', 5, { status: 'done', attempts: 4 });
    await startWorker({ external, env: FAST });

    await post('E1', 0).expect(202);
    await waitFor(async () => (await allDone('E1')) && isDone('E2', 1));

    expect(external.names()).toEqual(['E1', 'E2', 'E2', 'E2']);
    expect((await find('E2'))?.attempts).toBe(3);
  });
});
