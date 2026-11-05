# Ingest Service

This service accepts patient events over HTTP, answers at once, and processes each event in the background.
Processing calls a slow external system (simulated: 5 s per event) and stores the result in one MongoDB collection, `events`.
It guarantees three things:

- **Nothing is lost.** An event is on disk before the sender gets `202`, and a crashed worker's events go back to the queue.
- **Nothing is counted twice.** The api stores a resent event once, and each event stays one document.
- **Each patient's events are applied in `ts` order**, even when they arrive out of order. Two limits apply: we trust the sender's clock, and a `failed` event does not hold the patient (see [Problems and decisions](#problems-and-decisions)).

It runs on NestJS 11 (Fastify), MongoDB 8 and Node 26.
This README covers how to run and check the service (one command, see [Run it](#run-it)), how it works, and why it works that way.
It does not cover authentication, real clinical logic or a real external API: the external call is a fake that waits 5 s.

## Run it

You need Docker with Compose 2.40 or later. Run one command:

```bash
docker compose --profile load up --build --attach k6 --attach chaos --attach verify --abort-on-container-failure
```

It builds and starts everything, runs a 10-minute load test, and checks the data. It takes about 11 minutes and ends with `PASS` or `FAIL`. The exit code is 0 for `PASS`.

The command runs these steps in order:

1. It starts Mongo, the api and 2 workers, and waits until Mongo and the api pass their health checks.
2. `reset` deletes every event in the `ingest` database.
3. `k6` sends 1,000 events/min (the assignment load) for 10 minutes: events for 5,000 patients, 10% of them resent byte for byte, each `ts` up to 30 s in the past so a patient's events arrive out of order. It prints `✓` or `✗` for `p99 < 100 ms`.
4. `chaos` kills one worker with `SIGKILL` halfway through the load (minute 5 of 10) and waits for Compose to restart it.
5. `verify` waits for the queue to drain, then checks that Mongo holds every event that got `202`, no `dedupKey` repeats, and each patient's events finished in `ts` order.

A failed latency threshold shows as `✗` but does not change the exit code, so `verify` always runs. The stack keeps running afterwards; `docker compose --profile load down -v` removes it and its data.

### Results

Measured on one laptop (Docker VM with 8 vCPU), with CPU caps in compose so the numbers repeat:

| Load                       | POST p99 (k6)        | Failed requests | `verify --final`                           |
| -------------------------- | -------------------- | --------------- | ------------------------------------------ |
| 1,000 events/min, runs A–C | 8.0 / 10.9 / 15.2 ms | 0               | PASS: 0 lost, 0 duplicated, 0 out of order |

At 1,000 events/min the killed worker was back in 1 s, and the oldest pending event waited at most 37 s, because the dead worker's events wait for their lease (the 30 s hold a worker has on an event, see [How a worker processes an event](#how-a-worker-processes-an-event)) to expire.
A load run found a bug: the query that picks the next event filled its batch with busy patients (patients that already have an event in processing), and the queue grew without limit. The fix leaves busy patients out of the batch.
[`load/RESULTS.md`](load/RESULTS.md) has every run, a headroom check at 10,000 events/min, the stalls we measured and the tuning between runs.

### Optional

None of these are needed to check the service.

- **Short run.** Put `DURATION=1m` in front of the command above.
- **Send one event.** With the stack running, the first call answers `202`, and the same call again answers `200` with the same `id`:

  ```bash
  curl -i localhost:3000/events -H 'content-type: application/json' \
    -d '{"patientId":"p-1","type":"heart_rate","data":{"bpm":72},"ts":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"}'
  ```

- **Unit and e2e tests.** They need Node 26 (see `.nvmrc`) and the stack running (`docker compose up -d --build`):

  ```bash
  npm ci
  npm test
  npm run test:e2e
  ```

  The e2e tests use the compose Mongo with their own database, `ingest_test`, and start every test from an empty collection. Two tests pause the compose Mongo container, for about 2 s and for 3 s, to check what a stall does; the running api and workers stall with it.

  | Test file                        | Risk it covers                                                                                               |
  | -------------------------------- | ------------------------------------------------------------------------------------------------------------ |
  | `test/app.e2e-spec.ts`           | `GET /health` answers `200`                                                                                  |
  | `test/events.e2e-spec.ts`        | Contract, validation, duplicates (also 10 at once), UTC `ts`, `503` when Mongo stalls                        |
  | `test/processing.e2e-spec.ts`    | Order per patient, one event per patient at a time, 2 workers process each event once, shutdown              |
  | `test/failures.e2e-spec.ts`      | Retry, `failed`, expired lease, stale writes, hung external call, a 3 s Mongo stall, a resent `failed` event |
  | `test/late-arrivals.e2e-spec.ts` | Late events, reprocessing in `ts` order, a reprocess cut short by a crash                                    |
  | `src/**/*.spec.ts`               | Dedup key, retry policy, dispatch loop, claim caches, lease reaper, config checks                            |

- **Watch the queue.** `npm run verify` prints the count per status every 5 s while a load runs (after `npm ci`).

## Architecture

```
sender ──POST /events──▶ api ──insert (j: true)──▶ MongoDB: events ◀──claim / complete── worker × 2
                          │                              ▲
                          └── 202 / 200 / 400 / 503      └── lease reaper (in every worker, every 10 s)
```

- **api** (`src/main.ts`): validates the event, stores it as `pending` and answers. It never processes anything. Compose restarts a crashed one.
- **worker** (`src/worker.ts`): a Nest application context with no HTTP server. It claims events, calls the external system and stores the result. Compose runs 2 replicas and restarts a crashed one.
- **MongoDB** is both the store and the queue. The workers do not know about each other: the indexes coordinate them.

The api and the worker share one image and one codebase.
There is no Redis and no message broker.
The free version of BullMQ, the standard Nest queue, cannot run "one event at a time per patient, in `ts` order": BullMQ groups are a paid feature.
Mongo does it with two indexes.

### The `events` document

| Field                              | Meaning                                                                                                  |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `patientId`, `type`, `data`, `ts`  | The event as sent; `ts` is stored as a UTC `Date`                                                        |
| `dedupKey`                         | SHA-256 of the event's content; see [Duplicates](#senders-retry-and-send-the-same-event-twice)           |
| `status`                           | `pending` → `processing` → `done`, or `failed` after 5 attempts                                          |
| `attempts`, `availableAt`, `error` | Retry state: attempts in the current processing run, when the event may be claimed again, the last error |
| `leaseOwner`, `leaseUntil`         | The lease of the worker processing the event                                                             |
| `result`, `processedAt`            | Output of the last successful processing run                                                             |
| `reprocessCount`                   | How many times the event was reprocessed or requeued; part of the idempotency key                        |
| `receivedAt`                       | When the api stored the event                                                                            |

| Index                                                         | Purpose                                                                          |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `{ dedupKey: 1 }`, unique                                     | Stores a resent event once                                                       |
| `{ patientId: 1 }`, unique, partial on `status: 'processing'` | Lets at most one event per patient be in processing (the per-patient lock)       |
| `{ status: 1, availableAt: 1, patientId: 1 }`                 | Lists the busy patients and the patients with ready events, from the index alone |
| `{ patientId: 1, status: 1, ts: 1, _id: 1 }`                  | Finds a patient's head event, and the later `done` events of a late event        |

### How a worker processes an event

A **claim** moves one event from `pending` to `processing` and gives it a **lease**: the worker's id in `leaseOwner` and an expiry in `leaseUntil`, 30 s ahead.
Only the worker that holds the lease may write the result.
The **head** of a patient is the patient's `pending` or `processing` event with the lowest `ts` (ties broken by `_id`).
A **busy patient** has an event in processing.
The **per-patient lock** is the partial unique index on `patientId`: Mongo refuses a second event of one patient in processing.
A **late event** arrives after an event of the same patient with a higher `ts` is already `done`.
To **reprocess** an event is to set a `done` event back to `pending`, so that it runs again.

One dispatch loop per worker claims events. Each worker has 500 **slots** (`WORKER_CONCURRENCY`): at most 500 claimed events run at the same time.

1. Read the busy patients, and a batch of up to 100 ready `pending` events of the other patients.
2. For each patient in the batch, read the head. Claim it only if it is `pending` and ready (`availableAt` has passed); a head in processing means the patient is busy, and the worker skips it. The per-patient lock rejects the claim when the patient is busy anyway: another worker claimed it first, or the head is a lower-`ts` event that arrived while the patient was busy.
3. If the claimed event is late, reprocess the patient's `done` events with a higher `ts` (see [Order](#events-arrive-out-of-order-and-state-depends-on-their-sequence)).
4. Call the external system with a 10 s timeout.
5. Store `done` and the result, or schedule a retry, but only if the lease is still this claim's.

When no event is ready, or all 500 slots are in use, the loop waits until a running event finishes or 1 s passes.

### Logs

Each request and each processed event writes one JSON log line at the end, with all its context ("wide event").
A request line has the route, status, duration, `patientRef`, event id, `dedupKey` and `duplicate`.
A processing line has `patientRef` too: a keyed hash of `patientId` (see [Patient data](#patient-data-is-phi)).
A processing line has the attempt, the outcome (`done`, `retry`, `failed`, `lease_lost`, `write_failed`), the external call time, and `late` and `reprocessed` for late events.
`GET /health` checks that Mongo answers.

## Problems and decisions

Each decision below has a matching "why" comment at the code that implements it.

### Senders retry and send the same event twice

- **The dedup key is the event's content.** The payload has no id, so the **dedup key** is a SHA-256 of `patientId`, `type`, `ts` and `data`, with object keys sorted and array order kept. A unique index stores a resent event once, also when 10 copies arrive at the same moment, and the api answers the copy `200` with the original's `id` and status. Cost: two events that are truly identical become one. `src/events/dedup-key.ts`
- **`ts` becomes a UTC `Date`.** `10:00+02:00` and `08:00Z` are the same instant, so they give the same dedup key and the same order. The api rejects a `ts` without a timezone offset with `400`, because it does not name one instant. `src/events/dto/create-event.dto.ts`
- **A near-duplicate counts twice.** If a sender changes one field when it resends (for example a `data.sentAt` with the send time), the content differs, so the dedup key differs and the api stores 2 events. Nothing in the payload tells a resend from a new reading. Cost: that sender's events count twice, and both are processed. `src/events/dedup-key.ts`
- **A resent `failed` event stays `failed`.** The api answers it as a duplicate and does not queue it again; an operator requeues it on purpose (see [Operations](#operations)). `src/events/events.service.ts`

### Events arrive out of order, and state depends on their sequence

- **One event per patient at a time, head first.** The per-patient lock lets Mongo refuse a second event of one patient in processing, and a worker claims only the patient's head. Later events wait while the head runs or waits for a retry, so an event that arrives out of order while the patient is busy still runs in `ts` order. Cost: one patient gets at most 12 events/min (5 s each), across all types. `src/events/schemas/event.schema.ts`, `src/processing/processing.service.ts`
- **We trust the sender's clock.** Order is by `ts`, not by arrival. Cost: a sender whose clock runs ahead puts its events in the wrong order, and we do not detect it. `src/events/dto/create-event.dto.ts`
- **`ts` must fall between 7 days ago and 5 minutes ahead.** A `ts` in the future would make every later event of the patient late, and each would reprocess it; a very old `ts` would reprocess the patient's whole history. The api answers `400` outside the window. Cost: a sender offline for more than 7 days cannot deliver its backlog. `src/events/dto/create-event.dto.ts`
- **A late event reprocesses the later ones.** The worker reprocesses the patient's `done` events with a higher `ts`, and they run in `ts` order after the late event. `src/processing/processing.service.ts`
  - Why: each result depends on the events before it, so a result computed without the late event is wrong.
  - An equal `ts` is not late, and a new event with a higher `ts` reprocesses nothing.
  - Only `done` events are reprocessed; `failed` events wait for an operator.
  - No transaction is needed: the worker holds the per-patient lock, and if a crash cuts the reprocess short, the late event's next claim repeats it.
  - Cost: extra external calls (about 133 per 10-min run at 1,000 events/min), and the new processing run overwrites the old `result`.
  - No cap on how many events one late event reprocesses. The `ts` window limits it to 7 days of the patient's events: for a patient with 1 event/min, a 7-day-old event reprocesses 10,080 events, ~14 h with the patient held at 12 events/min.

### An event may never be lost or counted twice

- **The insert waits for the journal (`j: true`) before the `202`.** An accepted event survives a Mongo crash. Cost: each insert waits for a journal `fsync`. A slow `fsync` stalls the `202`s: in a 3-min load run, one slow `fsync` of ~500 ms matched a 1–2 s burst of slow requests. `src/events/events.service.ts`
- **The api rejects unknown fields instead of dropping them.** Dropping a field would lose clinical data silently, so the api answers `400`. A body over 64 KB gets `413`. `src/app.setup.ts`
- **Only the lease holder writes the result.** The write filters on `leaseOwner`, `attempts` and `reprocessCount`, so a worker that lost its lease, or a stale handle of the same worker, never overwrites a later claim. `src/processing/processing.service.ts`
- **The idempotency key changes on every reprocess.** The worker passes `dedupKey:reprocessCount` to the external system; a real client sends it as the `Idempotency-Key` header. A repeated call with the same key can be recognized, but a reprocess sends a new key on purpose. In our Mongo the event stays one document. Cost: the external system must treat a new key for the same event as "recompute and replace", not "add". It must also take ~85 concurrent calls at 1,000 events/min. `src/processing/external-processor.service.ts`, `src/processing/processing.service.ts`
- **5 attempts, then `failed`.** A failed external call retries after 2 s, 4 s, 8 s and 16 s; the patient waits during the retries. After the 5th attempt the event turns `failed`. That holds a patient for 30 s of waits plus 5 calls (up to 80 s at the 10 s timeout). Cost: an external outage longer than that fails the event. `src/processing/retry-policy.ts`
- **`failed` does not block the patient.** Blocking a patient forever for one bad event is worse. Cost: the later events run on a state that lacks the failed event, until an operator requeues it. `src/processing/processing.service.ts`

### Processes die in the middle of work

- **A lease of 30 s and a reaper.** If a worker dies, its events stay in `processing` until the lease expires. The reaper, which runs every 10 s in every worker, sends them back to `pending`. It is one `updateMany` over expired leases, so running it in several workers at once is safe. It registers with `SchedulerRegistry.addInterval`, not `@Interval`, because the period comes from config. Cost: a crashed worker's events wait up to 40 s. `src/processing/lease-reaper.service.ts`, `src/processing/processing.config.ts`
- **The lease uses Mongo's clock (`$$NOW`).** The claim sets `leaseUntil` and the reaper checks it, both with Mongo's clock. With each worker's own clock, a worker whose clock runs ahead would expire another worker's live lease early, and the external call would run twice. Cost: the claim is a pipeline update. `src/processing/processing.service.ts`, `src/processing/lease-reaper.service.ts`
- **An expired lease counts as an attempt.** An event that kills its worker every time turns `failed` after 5 attempts instead of looping forever. If a worker cannot write a result to Mongo, it also leaves the event to the reaper. `src/processing/lease-reaper.service.ts`, `src/processing/processing.service.ts`
- **The external timeout (10 s) stays below the lease (30 s).** Otherwise a second worker could claim an event whose first call is still running. The worker refuses to boot if `EXTERNAL_TIMEOUT_MS` ≥ `LEASE_MS`. `src/processing/processing.config.ts`, `src/processing/processing.service.ts`
- **The api keeps no state.** If the api dies after the insert and before the `202`, the sender times out and retries, and the dedup key answers `200` with the original `id`. If it dies before the insert, the retry stores the event. Compose restarts a crashed api (`restart: unless-stopped`). `src/events/events.service.ts`, `docker-compose.yml`
- **The api finishes its requests on `SIGTERM`.** Fastify stops taking connections and answers the requests in flight before the process exits. A request cut anyway (by `SIGKILL`) is retried by the sender, and the dedup key makes the retry safe. `src/main.ts`
- **The worker's Mongo calls time out after 5 s.** Without a timeout, a Mongo that stalls without closing the connection would hold a claim forever, and the worker would stop claiming while its container still shows running. With it, the claim fails, the loop logs it and tries again. Cost: a query slower than 5 s fails; a failed result write leaves the event to the reaper. `src/worker.module.ts`
- **Shutdown drains for 10 s.** On `SIGTERM` the worker stops claiming and waits up to 10 s for running events; compose waits 15 s before `SIGKILL`. Events that do not finish come back when their lease expires. `src/processing/worker.service.ts`

### A sender must get an answer immediately

- **`202` after the insert, processing later.** The api only validates and stores, so the measured server p99 was 6–11 ms at 1,000 events/min. `src/events/events.controller.ts`, `src/events/events.service.ts`
- **`503` after 2 s instead of waiting.** If Mongo stalls, the api answers `503` after 2 s. The sender retries, and the dedup key makes the retry safe: the stalled insert may still land, and then the retry gets `200`. Cost: the sender must retry on `503`. `src/events/events.service.ts`

### Traffic is 1,000 events/min for hours and will grow

Capacity is 2 workers × 500 slots ÷ 5 s = 200 events/s = 12,000 events/min.
At 1,000 events/min about 85 events are in processing (measured: 78–79 on average).
Workers scale by replicas: `docker compose up -d --scale worker=4`.

- **No backlog limit at the door.** The api accepts every valid event while Mongo writes. `src/events/events.service.ts`
  - Why: refusing would push the load back to the senders and trigger mass retries.
  - Cost: during a worker outage the queue grows, and it drains only at the spare capacity.
  - In theory, with every worker down for 10 min, the queue drains in about 1 min at 1,000 events/min (183 spare events/s). One patient drains at most 12 events/min.
- **One dispatch loop and a counter, not 500 polling loops.** An empty queue costs 1 query/s per worker. Cost: claims run one at a time per worker, so more throughput needs more replicas. `src/processing/worker.service.ts`

### Patient data is PHI

PHI is health data that identifies a patient. Under HIPAA, every system that stores it needs a BAA (the HIPAA contract with the vendor), and a log aggregator is one of those systems.

- **Logs carry `patientRef`, not `patientId`.** `patientRef` is the first 16 hex characters of an HMAC-SHA256 of `patientId`, keyed by `LOG_HASH_KEY`. One patient's lines still match, and the id stays out of the logs. A plain SHA-256 would not be enough: patient ids are often guessable, and anyone can hash every candidate and compare. The api and the worker refuse to boot without the key. Cost: to find one patient's lines, an operator computes the ref with the key. `src/common/patient-ref.ts`
- **`data` never goes to the logs.** It holds the clinical payload.
- **`patientId` stays in Mongo in plain text.** The worker needs it for the per-patient lock and the order. Encryption at rest and access control belong to the Mongo deployment, not to this service.
- **The compose file ships a dev key.** Production injects its own secret, the same one for api and worker.
- **The compose stack is for local runs only.** Mongo has no auth, so its port listens on `127.0.0.1` only, for the e2e tests. The `chaos` container of the load profile mounts `/var/run/docker.sock` and runs `docker run --pid=host`, which gives root on the Docker VM. Production needs Mongo auth and TLS, and no `chaos`. `docker-compose.yml`

## Trade-offs

| We accept                             | What it costs                                                      | When it shows                                                                                      |
| ------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Content is the dedup key              | Two truly identical events become one                              | A sender emits the same reading twice at the same `ts`                                             |
| Content is the dedup key              | A resend with one changed field counts twice                       | A sender adds a send time or a retry count when it resends                                         |
| Order by the sender's clock           | Wrong order, not detected                                          | A sender's clock runs ahead                                                                        |
| One event per patient at a time       | At most 12 events/min per patient; the rest queue                  | One patient sends faster than that                                                                 |
| Reprocess later events                | Extra external calls; the old `result` is overwritten              | Many events arrive late                                                                            |
| No cap on one reprocess               | Up to 7 days of a patient's events run again; the patient waits    | An event arrives days late                                                                         |
| New idempotency key per reprocess     | The external system must "recompute and replace"                   | The external system sums results per key                                                           |
| One external call per event, 5 s each | The external system holds ~85 concurrent calls at 1,000 events/min | Always                                                                                             |
| `failed` does not block the patient   | Later events run without the failed one                            | Until an operator requeues it                                                                      |
| Lease of 30 s                         | A crashed worker's events wait up to 40 s                          | Every worker crash or `SIGKILL`                                                                    |
| `j: true` on every insert             | Each `202` waits for the journal; a slow `fsync` stalls the api    | Load-test VM: one slow `fsync` of ~500 ms seen in a 3-min run, with a 1–2 s burst of slow requests |
| No backlog limit                      | After a worker outage, the queue drains only at the spare capacity | A worker outage at high load                                                                       |
| 2 × 500 slots                         | No room for many retries                                           | Many external failures at high load (see `load/RESULTS.md`)                                        |
| Single-node Mongo                     | No failover; `j: true` protects only against a crash of that node  | A lost disk                                                                                        |

## Operations

### Requeue a `failed` event

Fix the cause first, then set the event back to `pending` with fresh attempts. The `$inc` gives it a new idempotency key, so an external system that cached the failed calls' errors under the old key computes it again:

```bash
docker compose exec mongo mongosh ingest --eval '
  db.events.updateOne(
    { _id: ObjectId("<event id>"), status: "failed" },
    { $set: { status: "pending", attempts: 0, availableAt: new Date() },
      $inc: { reprocessCount: 1 } })'
```

The worker treats it as a late event: it reprocesses the patient's `done` events with a higher `ts`, which run after it in `ts` order.

### Configuration

| Variable              | Default         | Meaning                                                |
| --------------------- | --------------- | ------------------------------------------------------ |
| `MONGO_URI`           | none (required) | Mongo connection string                                |
| `PORT`                | `3000`          | api port                                               |
| `LOG_HASH_KEY`        | none (required) | Key of the `patientId` hash in logs                    |
| `WORKER_CONCURRENCY`  | `500`           | Events in processing per worker                        |
| `LEASE_MS`            | `30000`         | Lease length                                           |
| `EXTERNAL_TIMEOUT_MS` | `10000`         | External call timeout; must be lower than `LEASE_MS`   |
| `PROCESSING_DELAY_MS` | `5000`          | Duration of the fake external call                     |
| `RETRY_BASE_MS`       | `1000`          | Retry wait before attempt n+1 is `RETRY_BASE_MS × 2^n` |
| `REAPER_INTERVAL_MS`  | `10000`         | How often the reaper looks for expired leases          |

## What we would do with more time

- **A Mongo replica set of 3 nodes with `w: majority`**, so an accepted event survives the loss of one node, not only a crash.
- **Metrics and alerts** (Prometheus): queue size, age of the oldest pending event, slots in use, external error rate. Today the wide-event logs and `npm run verify` show this.
- **Autoscaling of workers** on the age of the oldest pending event, so a backlog drains faster than the spare capacity allows.
- **A history of results per reprocess.** Today a reprocess overwrites `result`, and `attempts` counts only the current processing run.
- **An optional `Idempotency-Key` header from the sender**, used as the dedup key when present, so a resend with a changed field counts once.
- **A cap or an alert on large reprocesses**, for example when one late event sends more than 100 events back.
- **A check on the sender's clock**, for example a flag on events whose `ts` is ahead of `receivedAt`.
- **An archiving policy.** Clinical data is not deleted, and 1,000 events/min is 1.44 million documents per day.
- **Batch inserts** (`insertMany`) per short request window, if the per-insert journal wait limits the api.
- **A wide event for requests that Fastify rejects before Nest** (malformed JSON, `413`, `404`). Today those get no log line.
- **An endpoint or script for requeueing**, instead of a `mongosh` update.
