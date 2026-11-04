# Load test results

Setup for every run: one laptop (Docker Desktop VM with 8 vCPU and 8 GB) runs k6, the api, 2 workers × 500 slots and a single-node Mongo. Each run lasts 10 min, with 5000 patients, 10% duplicates and `ts` up to 30s in the past. At minute 3 one worker gets SIGKILL (`load/chaos.sh`). `docker-compose.yml` caps CPU at Mongo 1.5, api 0.5, each worker 0.5 and k6 0.5 (3.5 of 8 cores); runs 1–3 at 10,000 events/min ran before the caps.

## Assignment load: 1,000 events/min

k6 takes a whole number of events per second, so the runs use 17/s = 1,020 events/min.

| Metric | Run A | Run B | Run C |
| --- | --- | --- | --- |
| Requests / `accepted_new` / duplicates (200) | 10,200 / 9,145 / 1,055 | 10,201 / 9,165 / 1,036 | 10,201 / 9,192 / 1,009 |
| k6 p50 / p95 / p99 / max | 4.5 / 6.6 / **8.0 ms** / 164 ms | 4.4 / 7.6 / **10.9 ms** / 481 ms | 4.5 / 8.1 / **15.2 ms** / 1.5 s |
| Server p50 / p99 / max | 3 / 6 ms / 104 ms | 3 / 8 ms / 200 ms | 3 / 11 ms / 1.0 s |
| Failed requests / k6 dropped iterations | 0 / 0 | 0 / 0 | 0 / 0 |
| Pending avg / max, oldest pending | not sampled | 5 / 10, 13 s | 4 / 20, 37 s |
| In processing avg / max | not sampled | 78 / 90 | 79 / 142 |
| Average CPU: Mongo / api / each worker | 20% / 4% / 2–4% | 22% / 4% / 3% | 26% / 5% / 4% |
| Host load average | 1.7–2.9 | 2.6–5.2 | 3.0–6.5 |
| `verify --final` | PASS | PASS | PASS |

Every final verify: documents = `accepted_new`, 0 lost, 0 pending, 0 failed, 0 duplicate `dedupKey`, 0 out of order. About 135 events per run arrived after an event with a later `ts` and sent about 133 done events back to the queue. The killed worker was back in 1 s. Its in-flight events wait for the lease to expire and the reaper to run, which is why the oldest pending event reached 37 s in run C. Run C's 1.5 s max came while the host load was at its highest (6.5). The p50 is higher than at 10,000 events/min (4.5 vs 1.6 ms); we did not investigate why.

Run it:

```bash
docker compose up -d --build
RATE=17 DURATION=10m npm run load & load/chaos.sh; wait
npm run verify -- --final
```

## Headroom: 10,000 events/min

The same stack at 167 events/s, 10× the assignment load.

| Metric | Run 1 (before fix) | Run 2 | Run 3 | Run 4 (after tuning, CPU caps) |
| --- | --- | --- | --- | --- |
| Requests / `accepted_new` / duplicates (200) | 100,201 / 90,246 / 9,955 | 99,092 / 89,251 / 9,828 | 99,928 / 89,885 / 10,043 | 100,162 / 90,178 / 9,984 |
| k6 p50 / p95 / p99 / max | 1.5 / 3.2 / 12 ms / 272 ms | 1.6 / 6.7 / 686 ms / 6.0 s | 2.1 / 20.5 / 370 ms / 2.3 s | 1.6 / 3.4 / **37.6 ms** / 980 ms |
| Failed requests | 0 | 13 (503, store timeout) | 0 | 0 |
| k6 dropped iterations (no free VU in time) | 0 | 1,109 | 273 | 39 |
| Server p99 | — | 10 ms outside the stall | 42 ms outside the stall | 17 ms, whole run |
| Peak pending / oldest pending age | 34k and growing / 236 s | 1,289 / 65 s | 2,209 / 52 s | not sampled |
| `verify --final` | not run (queue never drained) | PASS | PASS | PASS |

Final verify (run 4): 90,178 documents = `accepted_new`, 0 lost, 0 pending, 0 failed, 0 duplicate `dedupKey`, 0 out of order. 11,637 events arrived after an event with a later `ts`, which sent 10,674 done events back to the queue. The killed worker was back in under 1 s. Average CPU: Mongo 41% (peak 102% of its 150% cap), api 15%, each worker 14%, k6 10%. The host load average was 9.3 at the start and 2.8–5.4 for the rest of the run.

Run 3 (before tuning): in steady state 830–870 events were in processing (theory: 834), about 220 were pending, and the oldest pending event waited 15–25 s behind its busy patient. After the kill, the ~440 in-flight events of the dead worker stayed locked until the lease expired and the reaper ran (≤ 40 s). Pending got back to its baseline 85 s after the kill (run 2) and 105 s after it (run 3).

Fix found by run 1: the claim read the 100 oldest ready events, and those were mostly events queued behind busy patients. Each claim walked ~50 busy heads, so throughput stalled at ~100 claims/s against 167/s needed, and the queue grew without limit. The claim now leaves busy patients out of the batch (`fix: leave busy patients out of the claim batch`).

Tuning between runs 3 and 4, one measured change at a time (3-min runs at 167 events/s):

- The claim batch and head queries are covered by `{status, availableAt, patientId}` and `{patientId, status, ts, _id}`, and the batch reads only `patientId`. Documents read per claim: ~4,100 → ~1 (`explain` on 104k events).
- The busy-patient list is cached for 200 ms. Mongo CPU: 114% → 69–77%.
- The claim batch is reused for 200 ms. Index keys read: 51.5k/s → 12.6k/s, queries: 539/s → 325/s.
- Checked with no change: every index is read (`$indexStats`); a head waiting for a retry costs ~1.4 extra 1-key head lookups per claim at 20% external failures.

Stalls: run 4 had no 40–100 s stall, only bursts of 1–2 s (at most 55 POSTs ≥ 100 ms in one second). One burst measured with journal counters matched one slow journal `fsync` of ~500 ms on the VM disk (27 writes queued); checkpoints caused none. `j: true` stays, so these bursts are a cost of the environment. The long stalls of runs 2 and 3 matched a busy host: with the host load at 7–12, every container used about twice the CPU for the same work.

Known limit: with 20% of external calls failing, the 2 workers use 990 of 1,000 slots, because each retry repeats the 5 s call, and ready events grow from ~210 to ~540.
