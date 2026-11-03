// Reads the events collection directly. Live: status counts every 5s. --final: waits for an empty queue,
// then checks nothing was lost, duplicated or processed out of order. Runs on Node's built-in type stripping.
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import mongoose from 'mongoose';

const MONGO_URI = process.env.MONGO_URI ?? 'mongodb://localhost:27017/ingest';
const SUMMARY = 'load/summary.json';
const INTERVAL_MS = 5000;

interface EventDoc {
  patientId: string;
  dedupKey: string;
  status: 'pending' | 'processing' | 'done' | 'failed';
  ts: Date;
  receivedAt: Date;
  availableAt: Date;
  processedAt?: Date;
  error?: string;
  reprocessCount: number;
}
type Events = mongoose.mongo.Collection<EventDoc>;
type Snapshot = Record<EventDoc['status'], number> & {
  oldestPendingAgeS: number;
};

async function snapshot(events: Events): Promise<Snapshot> {
  const s: Snapshot = {
    pending: 0,
    processing: 0,
    done: 0,
    failed: 0,
    oldestPendingAgeS: 0,
  };
  // One indexed count per status: a $group would scan the whole collection every 5s, under load.
  for (const status of ['pending', 'processing', 'done', 'failed'] as const) {
    s[status] = await events.countDocuments({ status });
  }
  // availableAt is when the event became ready (insert, retry or reprocess): this is its wait in the queue.
  const oldest = await events.findOne(
    { status: 'pending' },
    { sort: { availableAt: 1 } },
  );
  if (oldest) {
    s.oldestPendingAgeS = Math.round(
      (Date.now() - oldest.availableAt.getTime()) / 1000,
    );
  }
  return s;
}

function print(s: Snapshot): void {
  const time = new Date().toISOString().slice(11, 19);
  console.log(
    `${time} pending=${s.pending} processing=${s.processing} done=${s.done} ` +
      `failed=${s.failed} oldestPendingAgeS=${s.oldestPendingAgeS}`,
  );
}

async function final(events: Events): Promise<boolean> {
  let s = await snapshot(events);
  while (s.pending + s.processing > 0) {
    print(s);
    await sleep(INTERVAL_MS);
    s = await snapshot(events);
  }
  print(s);

  const summary = JSON.parse(readFileSync(SUMMARY, 'utf8')) as {
    metrics: {
      accepted_new?: { count: number };
      http_req_failed: { passes: number };
    };
  };
  const acceptedNew = summary.metrics.accepted_new?.count ?? 0;
  // A failed request (503 after the 2s timeout) may still have stored its event; the sender would retry.
  const failedRequests = summary.metrics.http_req_failed.passes;
  const total = await events.countDocuments();

  for await (const f of events.find({ status: 'failed' })) {
    console.log(`failed ${String(f._id)}: ${f.error}`);
  }

  const [dup] = await events
    .aggregate<{ keys: number }>([
      { $group: { _id: '$dedupKey', n: { $sum: 1 } } },
      { $match: { n: { $gt: 1 } } },
      { $count: 'keys' },
    ])
    .toArray();

  // Walks each patient from the highest ts down: every event's last processing must come before
  // the one after it, and an event that arrived after a higher-ts one is an out-of-order arrival.
  let outOfOrder = 0;
  let arrivedOutOfOrder = 0;
  let next: EventDoc | null = null;
  let firstArrivalAfter = Infinity;
  const done = events
    .find({ status: 'done' })
    .sort({ patientId: 1, ts: -1, _id: -1 });
  for await (const e of done) {
    if (next?.patientId !== e.patientId) {
      firstArrivalAfter = Infinity;
    } else if (e.processedAt! >= next.processedAt!) {
      outOfOrder++;
    }
    if (e.receivedAt.getTime() > firstArrivalAfter) arrivedOutOfOrder++;
    firstArrivalAfter = Math.min(firstArrivalAfter, e.receivedAt.getTime());
    next = e;
  }

  const [reprocessed] = await events
    .aggregate<{ events: number; runs: number }>([
      { $match: { reprocessCount: { $gt: 0 } } },
      {
        $group: {
          _id: null,
          events: { $sum: 1 },
          runs: { $sum: '$reprocessCount' },
        },
      },
    ])
    .toArray();

  const checks = {
    lost: Math.max(0, acceptedNew - total),
    // More documents than 202s plus failed requests would mean an event stored twice or out of nowhere.
    unexplained: Math.max(0, total - acceptedNew - failedRequests),
    pending: s.pending + s.processing,
    duplicateKeys: dup?.keys ?? 0,
    outOfOrder,
  };
  const report = {
    acceptedNew,
    failedRequests,
    total,
    done: s.done,
    failed: s.failed,
    ...checks,
    arrivedOutOfOrder,
    reprocessedEvents: reprocessed?.events ?? 0,
    reprocessRuns: reprocessed?.runs ?? 0,
  };
  console.log(JSON.stringify(report, null, 2));
  const ok = Object.values(checks).every((v) => v === 0);
  console.log(ok ? 'PASS' : 'FAIL');
  return ok;
}

async function main(): Promise<void> {
  await mongoose.connect(MONGO_URI);
  const events: Events = mongoose.connection.db!.collection('events');
  if (process.argv.includes('--final')) {
    process.exitCode = (await final(events)) ? 0 : 1;
    await mongoose.disconnect();
    return;
  }
  for (;;) {
    print(await snapshot(events));
    await sleep(INTERVAL_MS);
  }
}

void main();
