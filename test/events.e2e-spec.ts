import { execSync } from 'node:child_process';
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Types } from 'mongoose';
import { patientRef } from '../src/common/patient-ref';
import { EventsService } from '../src/events/events.service';
import request, { Response } from 'supertest';
import {
  captureLogs,
  clearEvents,
  createApi,
  eventsCollection,
  DAY,
} from './helpers';

interface ResponseBody {
  id: string;
  status: string;
  message: string | string[];
}
const bodyOf = (res: Response) => res.body as ResponseBody;

const validEvent = () => ({
  patientId: 'p-1',
  type: 'vitals',
  data: { hr: 72, bp: { sys: 120, dia: 80 } },
  ts: `${DAY}T08:00:00Z`,
});

describe('POST /events (e2e)', () => {
  let app: NestFastifyApplication;
  const post = (body: object | string) =>
    request(app.getHttpServer())
      .post('/events')
      .set('content-type', 'application/json')
      .send(body);
  const count = () => eventsCollection(app).countDocuments();

  beforeAll(async () => {
    app = await createApi();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await clearEvents(app);
  });

  it('accepts a new event and stores it as pending', async () => {
    const res = await post(validEvent()).expect(202);

    const { id, ...rest } = bodyOf(res);
    expect(rest).toEqual({ status: 'pending' });
    const doc = await eventsCollection(app).findOne({
      _id: new Types.ObjectId(id),
    });
    expect(doc?.status).toBe('pending');
    expect(doc?.attempts).toBe(0);
    expect(doc?.dedupKey).toMatch(/^[0-9a-f]{64}$/);
    expect(doc?.receivedAt).toBeInstanceOf(Date);
    expect(await count()).toBe(1);
  });

  it('answers 200 with the same id for a sequential duplicate', async () => {
    const first = await post(validEvent()).expect(202);

    const second = await post(validEvent()).expect(200);

    expect(bodyOf(second)).toEqual({ id: bodyOf(first).id, status: 'pending' });
    expect(await count()).toBe(1);
  });

  it('stores one event when 10 duplicates arrive at once', async () => {
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => post(validEvent())),
    );

    const statuses = responses.map((r) => r.status).sort();
    expect(statuses).toEqual([
      200, 200, 200, 200, 200, 200, 200, 200, 200, 202,
    ]);
    expect(new Set(responses.map((r) => bodyOf(r).id)).size).toBe(1);
    expect(await count()).toBe(1);
  });

  it('treats reordered data keys as a duplicate', async () => {
    const first = await post(validEvent()).expect(202);

    const second = await post({
      ...validEvent(),
      data: { bp: { dia: 80, sys: 120 }, hr: 72 },
    }).expect(200);

    expect(bodyOf(second).id).toBe(bodyOf(first).id);
  });

  it('treats the same content with another ts as a new event', async () => {
    const first = await post(validEvent()).expect(202);

    const second = await post({
      ...validEvent(),
      ts: `${DAY}T08:00:01Z`,
    }).expect(202);

    expect(bodyOf(second).id).not.toBe(bodyOf(first).id);
    expect(await count()).toBe(2);
  });

  it.each(['patientId', 'type', 'data', 'ts'])(
    'rejects a payload without %s',
    async (field) => {
      const body: Record<string, unknown> = validEvent();
      delete body[field];

      const res = await post(body).expect(400);

      expect(JSON.stringify(bodyOf(res).message)).toContain(field);
      expect(await count()).toBe(0);
    },
  );

  it.each<[string, Record<string, unknown>]>([
    ['empty patientId', { patientId: '' }],
    ['ts that is not a date', { ts: 'ontem' }],
    ['ts without a timezone offset', { ts: `${DAY}T08:00:00` }],
    ['ts more than 5 minutes ahead', { ts: '9999-12-31T00:00:00Z' }],
    ['ts more than 7 days old', { ts: '1900-01-01T00:00:00Z' }],
    ['patientId over 128 characters', { patientId: 'p'.repeat(129) }],
    ['type over 64 characters', { type: 't'.repeat(65) }],
    ['data as a string', { data: 'texto' }],
    ['data as an array', { data: [1, 2] }],
  ])('rejects %s', async (_case, change) => {
    await post({ ...validEvent(), ...change }).expect(400);

    expect(await count()).toBe(0);
  });

  it('rejects an unknown field', async () => {
    const res = await post({ ...validEvent(), source: 'ehr' }).expect(400);

    expect(JSON.stringify(bodyOf(res).message)).toContain('source');
    expect(await count()).toBe(0);
  });

  it('rejects malformed JSON', async () => {
    await post('{"patientId":').expect(400);

    expect(await count()).toBe(0);
  });

  it('rejects a body over 64KB', async () => {
    await post({
      ...validEvent(),
      data: { blob: 'x'.repeat(65 * 1024) },
    }).expect(413);

    expect(await count()).toBe(0);
  });

  describe('wide events', () => {
    let logs: ReturnType<typeof captureLogs>;

    afterEach(() => logs.restore());

    it('logs one line for a new event', async () => {
      logs = captureLogs();

      const res = await post(validEvent()).expect(202);

      const lines = logs.wideEvents();
      expect(lines).toHaveLength(1);
      const { durationMs, ...rest } = lines[0];
      expect(typeof durationMs).toBe('number');
      expect(rest).toEqual({
        method: 'POST',
        route: '/events',
        status: 202,
        patientRef: patientRef('p-1'),
        eventId: bodyOf(res).id,
        duplicate: false,
      });
    });

    it('logs one line marked as duplicate', async () => {
      const first = await post(validEvent()).expect(202);
      logs = captureLogs();

      await post(validEvent()).expect(200);

      const lines = logs.wideEvents();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        status: 200,
        duplicate: true,
        eventId: bodyOf(first).id,
      });
    });

    it('logs one line with the error for an invalid payload', async () => {
      logs = captureLogs();

      await post({ ...validEvent(), patientId: '' }).expect(400);

      const lines = logs.wideEvents();
      expect(lines).toHaveLength(1);
      expect(lines[0].status).toBe(400);
      expect(lines[0].error).toContain('patientId');
    });

    it('logs an unexpected error as one line with status 500', async () => {
      jest
        .spyOn(app.get(EventsService), 'create')
        .mockRejectedValueOnce(new Error('boom'));
      logs = captureLogs();

      await post(validEvent()).expect(500);

      expect(logs.lines()).toHaveLength(1);
      expect(logs.wideEvents()[0]).toMatchObject({
        status: 500,
        error: 'boom',
      });
    });
  });

  it('creates the four planned indexes', async () => {
    const indexes = await eventsCollection(app).indexes();
    const byKey = (key: object) =>
      indexes.find((i) => JSON.stringify(i.key) === JSON.stringify(key));

    expect(byKey({ dedupKey: 1 })).toMatchObject({ unique: true });
    expect(byKey({ patientId: 1 })).toMatchObject({
      unique: true,
      partialFilterExpression: { status: 'processing' },
    });
    expect(byKey({ status: 1, availableAt: 1, patientId: 1 })).toBeDefined();
    expect(byKey({ patientId: 1, status: 1, ts: 1, _id: 1 })).toBeDefined();
  });

  it('stores ts as a UTC Date', async () => {
    const res = await post({
      ...validEvent(),
      ts: `${DAY}T10:00:00+02:00`,
    }).expect(202);

    const doc = await eventsCollection(app).findOne({
      _id: new Types.ObjectId(bodyOf(res).id),
    });
    expect(doc?.ts).toEqual(new Date(`${DAY}T08:00:00Z`));
  });

  it('treats the same instant in another offset as a duplicate', async () => {
    const first = await post(validEvent()).expect(202);

    const second = await post({
      ...validEvent(),
      ts: `${DAY}T10:00:00+02:00`,
    }).expect(200);

    expect(bodyOf(second).id).toBe(bodyOf(first).id);
  });

  it('answers 503 within ~2s when Mongo stalls, and the retry succeeds', async () => {
    execSync('docker compose pause mongo', { stdio: 'ignore' });
    let elapsed: number;
    try {
      const start = Date.now();
      await post(validEvent()).expect(503);
      elapsed = Date.now() - start;
    } finally {
      execSync('docker compose unpause mongo', { stdio: 'ignore' });
    }
    expect(elapsed).toBeGreaterThan(1500);
    expect(elapsed).toBeLessThan(3000);

    // The stalled insert may still land after unpause; the dedupKey makes the retry safe.
    const retry = await post(validEvent());
    expect([200, 202]).toContain(retry.status);
    expect(await count()).toBe(1);
  }, 15_000);
});
