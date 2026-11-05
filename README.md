# Ingest Service

This service accepts patient events over HTTP, answers at once, and processes each event in the background.
Processing calls a slow external system (a fake that waits 5 s) and stores the result in one MongoDB collection, `events`.
It runs on NestJS 11 (Fastify), MongoDB 8 and Node 26. It guarantees three things:

- **Nothing is lost.** An event is on disk before the sender gets `202`, and a crashed worker's events go back to the queue.
- **Nothing is counted twice.** The api stores a resent event once, and each event stays one document.
- **Each patient's events are applied in `ts` order**, even when they arrive out of order. Limits: we trust the sender's clock, and a `failed` event does not hold the patient.

## Run it

You need Docker with Compose 2.40 or later:

```bash
docker compose --profile load up --build --attach k6 --attach chaos --attach verify --abort-on-container-failure
```

It takes about 11 minutes and ends with `PASS` (exit code 0) or `FAIL`. `DURATION=1m` in front gives a run of about 2 minutes.

1. It starts Mongo, the api and 2 workers; `reset` empties the `ingest` database.
2. `k6` sends 1,000 events/min for 10 min: 500 patients, 10% resent byte for byte, each `ts` up to 30 s in the past. About 1 event in 8 arrives after a later one of its patient and reprocesses it. It prints `✓` or `✗` for `p99 < 100 ms`, without changing the exit code.
3. `chaos` kills one worker with `SIGKILL` halfway through, and Compose restarts it.
4. `verify` waits for the queue to drain and checks: no request failed, every `202` is stored, none ended `failed`, no `dedupKey` repeats, and each patient's events finished in `ts` order. The fake external system keeps no state, so the e2e tests check the call order with a spy instead.

`docker compose --profile load down -v` removes the stack and its data.

| Run (one laptop, CPU caps in compose)   | POST p99 (k6)        | Failed requests | `verify --final`                        |
| --------------------------------------- | -------------------- | --------------- | --------------------------------------- |
| A–C: 1,000 events/min, 5,000 patients   | 8.0 / 10.9 / 15.2 ms | 0               | PASS: 0 lost, 0 duplicated, 0 reordered |
| D: 1,000 events/min, 500 patients (now) | 9.6 ms               | 0               | PASS, also 0 failed                     |

The killed worker was back in 1 s; its events waited up to 37 s for their lease to expire.
A load run found a bug: busy patients filled the claim batch and the queue grew without limit. [`load/RESULTS.md`](load/RESULTS.md) has every run.

**Tests** need Node 26 and the stack running (`docker compose up -d --build`): `npm ci && npm test && npm run test:e2e`.
The e2e tests use their own database, `ingest_test`, start each test from an empty collection, and pause the Mongo container for 2–5 s in 3 tests.
They cover validation and duplicates (`events`), order and one event per patient (`processing`), retries, leases and stalls (`failures`), and late events (`late-arrivals`).

**One event:** the first call answers `202`, the same call again `200` with the same `id`:

```bash
curl -i localhost:3000/events -H 'content-type: application/json' \
  -d '{"patientId":"p-1","type":"heart_rate","data":{"bpm":72},"ts":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"}'
```

## Architecture

```
sender ──POST /events──▶ api ──insert (j: true)──▶ MongoDB: events ◀──claim / complete── worker × 2
                          └── 202 / 200 / 400 / 503      ▲
                                                         └── lease reaper (in every worker, every 10 s)
```

- **api** (`src/main.ts`) validates the event, stores it as `pending` and answers. It never processes.
- **worker** (`src/worker.ts`) is a Nest application context without HTTP. It claims events, calls the external system and stores the result.
- **MongoDB** is the store and the queue; its indexes coordinate the workers. There is no broker: BullMQ's per-group ordering ("one at a time per patient") is a paid feature, and Mongo does it with two indexes.

| Index                                                         | Purpose                                                     |
| ------------------------------------------------------------- | ----------------------------------------------------------- |
| `{ dedupKey: 1 }`, unique                                     | Stores a resent event once                                  |
| `{ patientId: 1 }`, unique, partial on `status: 'processing'` | The per-patient lock: one event per patient in processing   |
| `{ status: 1, availableAt: 1, patientId: 1 }`                 | Lists busy, waiting and ready patients from the index alone |
| `{ patientId: 1, status: 1, ts: 1, _id: 1 }`                  | Finds a patient's head, and the later `done` events to redo |

**How a worker processes an event.** The **head** of a patient is its `pending` or `processing` event with the lowest `ts`. A **claim** sets the head to `processing` with a 30 s **lease** (`leaseOwner`, `leaseUntil`). One dispatch loop per worker claims, with up to 500 events running (`WORKER_CONCURRENCY`):

1. Read the busy patients, the patients whose head waits for a retry, and up to 100 ready events of the others.
2. For each patient, claim the head if it is `pending` and ready. The per-patient lock refuses it if the patient got busy meanwhile.
3. If the event is **late** (a later event of the patient is `done`), set those later events back to `pending`.
4. Call the external system (10 s timeout), then store `done` or schedule a retry, only if the lease is still this claim's.

**Logs.** Each request and each processed event writes one JSON line at the end ("wide event"), with `patientRef`, the event id, and the status or outcome (`done`, `retry`, `failed`, `lease_lost`, `write_failed`). `GET /health` checks Mongo.

## Problems and decisions

Each decision names its trade-off ("Cost:") and has a "why" comment at the code.

### Senders retry and send the same event twice

- **The dedup key is the event's content**: a SHA-256 of `patientId`, `type`, `ts` and `data`, keys sorted. A unique index stores a resent event once, also 10 copies at once; the copy gets `200` with the original's `id`. Cost: identical events become one, also 2 equal readings in 1 s from a sender whose `ts` has whole seconds. `src/events/dedup-key.ts`
- **`ts` becomes a UTC `Date`**, so `10:00+02:00` and `08:00Z` dedupe and order as one instant; a `ts` without offset gets `400`. Cost: events that differ only below 1 ms become one. `src/events/dto/create-event.dto.ts`
- **A near-duplicate counts twice.** A resend with one changed field (a `data.sentAt`) has a new key. Nothing in the payload tells it from a new reading. `src/events/dedup-key.ts`
- **A resent `failed` event stays `failed`**; an operator requeues it on purpose. `src/events/events.service.ts`

### Events arrive out of order, and state depends on their sequence

- **One event per patient at a time, head first**, held by the per-patient lock. Later events wait while the head runs or waits for a retry. Cost: at most 12 events/min per patient; a faster sender (a 1 Hz device) builds a queue that never drains, and nothing alerts. `src/events/schemas/event.schema.ts`
- **The claim checks `availableAt` again when it writes**, so a head that another worker failed meanwhile waits out its backoff. Cost: an event that turns ready mid-claim waits one loop. `src/processing/processing.service.ts`
- **A patient whose head waits for a retry stays out of the batch**, or its queued events fill it and the workers idle. Cost: a late event waits for that retry too. `src/processing/processing.service.ts`
- **We trust the sender's clock**: order is by `ts`. Cost: a clock running ahead orders its events wrongly, undetected. `src/events/dto/create-event.dto.ts`
- **`ts` must fall between 7 days ago and 5 min ahead**, so a future `ts` cannot make every later event late, and an old one cannot redo a whole history. Cost: a sender offline over 7 days gets `400` for its backlog. `src/events/dto/create-event.dto.ts`
- **`_id` breaks a tie on equal `ts`**, in arrival order with one api. Cost: ObjectIds of several api replicas do not compare by arrival, so equal-`ts` events may swap. `src/processing/processing.service.ts`
- **A late event reprocesses the patient's later `done` events**, in `ts` order after it, because each result depends on the ones before. `failed` events wait for an operator. No transaction: the worker holds the lock, and a reset cut short by a crash repeats on the next claim. Cost: extra calls (1,090 in run D), the old `result` is overwritten, and there is no cap: a 7-day-old event of a 1 event/min patient redoes 10,080 events (~14 h). `src/processing/processing.service.ts`

### An event may never be lost or counted twice

- **The insert waits for the journal (`j: true`) before the `202`.** Cost: a slow `fsync` stalls the `202`s (one of ~500 ms gave a 1–2 s burst), and a single Mongo node survives a crash, not a lost disk. `src/events/events.service.ts`
- **Unknown fields get `400`, not dropped**: dropping one would lose clinical data. A body over 64 KB gets `413`. `src/app.setup.ts`
- **A body nested deeper than 20 levels gets `400`**, checked before validation: Mongo's depth error and class-transformer's stack overflow would be a `500` the sender retries forever. Cost: `data` nests at most 19 levels. `src/common/max-depth.pipe.ts`
- **Only the lease holder writes**: the write filters on `leaseOwner`, `attempts` and `reprocessCount`, so a stale handle never overwrites a later claim. `src/processing/processing.service.ts`
- **The idempotency key is `dedupKey:reprocessCount`**, sent as `Idempotency-Key` by a real client. Cost: the external system must treat a new key for the same event as "replace", not "add", and take ~85 concurrent calls. `src/processing/external-processor.service.ts`
- **5 attempts, then `failed`**, with waits of 2, 4, 8 and 16 s while the patient waits (up to 80 s). Cost: a longer external outage fails the event. `src/processing/retry-policy.ts`
- **`failed` does not block the patient**, which is worse than a missing event. Cost: later events run on a state without it until an operator requeues it. `src/processing/processing.service.ts`

### Processes die in the middle of work

- **A 30 s lease and a reaper** (one `updateMany` every 10 s in every worker, safe to run at once) send a dead worker's events back to `pending`. Cost: they wait up to 40 s. `src/processing/lease-reaper.service.ts`
- **The lease uses Mongo's clock (`$$NOW`)**, so a worker clock running ahead cannot expire a live lease. Cost: the claim is a pipeline update. `src/processing/processing.service.ts`
- **Ready time uses the api's and the worker's clocks**; `$$NOW` would put `$expr` in the 3 claim queries. Cost: a new event waits as long as the api's clock runs ahead (ms with NTP). `src/processing/processing.service.ts`
- **An expired lease counts as an attempt**, so an event that kills its worker turns `failed` after 5. A failed result write also leaves the event to the reaper. `src/processing/lease-reaper.service.ts`
- **The external timeout (10 s) stays below the lease (30 s)**; the worker refuses to boot otherwise. `src/processing/processing.config.ts`
- **The api keeps no state.** If it dies after the insert, the sender's retry gets `200` with the original `id`. `src/events/events.service.ts`
- **The api finishes its requests on `SIGTERM`**; a request cut by `SIGKILL` is retried safely. `src/main.ts`
- **The worker's Mongo calls time out after 5 s**, so a stalled Mongo cannot freeze the claim loop. Cost: a slower query fails. `src/worker.module.ts`
- **Shutdown drains for 10 s**; compose waits 15 s before `SIGKILL`, and unfinished events return with their lease. `src/processing/worker.service.ts`

### A sender must get an answer immediately

- **`202` after the insert, processing later**: server p99 6–11 ms at 1,000 events/min. `src/events/events.controller.ts`
- **`503` after 2 s if Mongo stalls**; the dedup key makes the retry safe. Cost: the sender must retry on `503`. `src/events/events.service.ts`

### Traffic is 1,000 events/min for hours and will grow

In theory 2 workers × 500 slots ÷ 5 s = 12,000 events/min; no run measured it since the claim caches were removed, and each worker claims one event at a time. About 85 events are in processing at 1,000 events/min. Workers scale with `docker compose up -d --scale worker=4`.

- **No backlog limit at the door**: refusing would push load back and trigger mass retries. Cost: after a 10-min worker outage, the queue needs ~1 min of spare capacity in theory, but ~2 min with 500 patients, since each drains 12 events/min. `src/events/events.service.ts`
- **One dispatch loop, not 500 polling loops**: an empty queue costs 1 query/s per worker. Cost: more claim throughput needs more replicas. `src/processing/worker.service.ts`

### Patient data is PHI

A log aggregator stores what it gets, so under HIPAA it needs a BAA. The logs keep PHI out:

- **Logs carry `patientRef`**, an HMAC-SHA256 of `patientId` keyed by `LOG_HASH_KEY` (a plain hash of a guessable id is reversible). Both apps refuse to boot without the key. `src/common/patient-ref.ts`
- **`data` and `dedupKey` never go to the logs**; the `dedupKey` is an unkeyed hash that confirms a guessed reading. `src/events/events.controller.ts`
- **A Mongo server error goes to the logs as name and code only**: its message can quote field paths or a key. `src/common/errors.ts`
- **`patientId` stays in Mongo in plain text** for the lock and the order; encryption at rest and access belong to the deployment.
- **The compose stack is local only**: a dev key, Mongo and the api without auth on `127.0.0.1`, and a `chaos` container with the Docker socket (root on the Docker VM). `docker-compose.yml`

## Operations

Requeue a `failed` event after fixing the cause. The `$inc` gives it a new idempotency key, and the worker treats it as late:

```bash
docker compose exec mongo mongosh ingest --eval '
  db.events.updateOne(
    { _id: ObjectId("<event id>"), status: "failed" },
    { $set: { status: "pending", attempts: 0, availableAt: new Date() },
      $inc: { reprocessCount: 1 } })'
```

`npm run verify` prints the count per status every 5 s. Configuration (required: `MONGO_URI`, `LOG_HASH_KEY`):

| Variable              | Default | Meaning                                                |
| --------------------- | ------- | ------------------------------------------------------ |
| `PORT`                | `3000`  | api port                                               |
| `WORKER_CONCURRENCY`  | `500`   | Events in processing per worker                        |
| `LEASE_MS`            | `30000` | Lease length                                           |
| `EXTERNAL_TIMEOUT_MS` | `10000` | External call timeout; must be lower than `LEASE_MS`   |
| `PROCESSING_DELAY_MS` | `5000`  | Duration of the fake external call                     |
| `RETRY_BASE_MS`       | `1000`  | Retry wait before attempt n+1 is `RETRY_BASE_MS × 2^n` |
| `REAPER_INTERVAL_MS`  | `10000` | How often the reaper looks for expired leases          |

## What we would do with more time

- A 3-node replica set with `w: majority`, so an accepted event survives a lost node.
- Metrics and alerts: queue size, oldest pending age, slots in use, external errors, and the queue of each patient.
- Worker autoscaling on the oldest pending age, and a worker liveness heartbeat for Kubernetes.
- For senders above 12 events/min per patient: a lock per patient and type, or one call per batch, depending on what the state means.
- An optional `Idempotency-Key` header from the sender as the dedup key.
- A cap or alert on large reprocesses, a history of results per reprocess, and a flag on `ts` ahead of `receivedAt`.
- An archiving policy: 1,000 events/min is 1.44 million documents per day.
- Less claim contention with 10 workers (a random start in the batch), and index builds before the deploy instead of at boot.
- A log line for requests Fastify rejects before Nest (malformed JSON, `413`, `404`), and a requeue endpoint.
