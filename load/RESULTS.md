# Load test results

Setup: one laptop (Docker Desktop VM with 8 vCPU and 8 GB) runs k6, the api, 2 workers × 500 slots and a single-node Mongo. The run lasts 10 min at 167 req/s, with 5000 patients, 10% duplicates and `ts` up to 30s in the past. At minute 3 one worker gets SIGKILL (`load/chaos.sh`). Run 4 adds CPU caps in `docker-compose.yml`: Mongo 1.5, api 0.5, each worker 0.5, k6 0.5 (3.5 of 8 cores).

| Metric | Run 1 (before fix) | Run 2 | Run 3 | Run 4 (after tuning) |
| --- | --- | --- | --- | --- |
| Requests / `accepted_new` / duplicates (200) | 100,201 / 90,246 / 9,955 | 99,092 / 89,251 / 9,828 | 99,928 / 89,885 / 10,043 | 100,162 / 90,178 / 9,984 |
| k6 p50 / p95 / p99 / max | 1.5 / 3.2 / 12 ms / 272 ms | 1.6 / 6.7 / 686 ms / 6.0 s | 2.1 / 20.5 / 370 ms / 2.3 s | 1.6 / 3.4 / **37.6 ms** / 980 ms |
| Failed requests | 0 | 13 (503, store timeout) | 0 | 0 |
| k6 dropped iterations (no free VU in time) | 0 | 1,109 | 273 | 39 |
| Server p99 outside the stall window | — | 10 ms | 42 ms | 17 ms (whole run, no long stall) |
| Peak pending / oldest pending age | 34k and growing / 236 s | 1,289 / 65 s | 2,209 / 52 s | not sampled |
| `verify --final` | not run (queue never drained) | PASS | PASS | PASS |

Final verify (run 3, counts check of that time): 89,885 documents = `accepted_new`, 0 lost, 0 pending, 0 failed, 0 duplicate `dedupKey`, 0 out of order. 11,851 events arrived after an event with a later `ts`. Worker wide events show 9,610 late events, which sent 10,316 done events back to the queue (`reprocessCount` total: 10,355). The 39 missing from the logs are probably resets made by the killed worker: SIGKILL cuts its wide events before they are written. This is not verified. In steady state 830–870 events are in processing (theory: 834), about 220 are pending, and the oldest pending event waits 15–25 s behind its busy patient.

Recovery after the kill: the worker is back in 1 s. Its ~440 in-flight events stay locked until the lease expires and the reaper runs (≤ 40 s). Pending got back to its baseline 85 s after the kill (run 2) and 105 s after it (run 3). The theoretical estimate is ~200 s: 40 s of outage, cleared at 20% headroom (5×).

Fix found by run 1: the claim read the 100 oldest ready events, and those were mostly events queued behind busy patients. Each claim walked ~50 busy heads, so throughput stalled at ~100 claims/s against 167/s needed, and the queue grew without limit. The claim now leaves busy patients out of the batch (`fix: leave busy patients out of the claim batch`).

Final verify (run 4): 90,178 documents = `accepted_new`, 0 lost, 0 pending, 0 failed, 0 duplicate `dedupKey`, 0 out of order. 11,637 events arrived after an event with a later `ts`, which sent 10,674 done events back to the queue. The killed worker was back in under 1 s. Average CPU: Mongo 41% (peak 102% of its 150% cap), api 15%, each worker 14%, k6 10%. The host load average was 9.3 at the start and 2.8–5.4 for the rest of the run.

Tuning between runs 3 and 4, one measured change at a time (3-min runs at 167 req/s):

- The claim batch and head queries are covered by `{status, availableAt, patientId}` and `{patientId, status, ts, _id}`, and the batch reads only `patientId`. Documents read per claim: ~4,100 → ~1 (`explain` on 104k events).
- The busy-patient list is cached for 200 ms. Mongo CPU: 114% → 69–77%.
- The claim batch is reused for 200 ms. Index keys read: 51.5k/s → 12.6k/s, queries: 539/s → 325/s.
- Checked with no change: every index is read (`$indexStats`); a head waiting for a retry costs ~1.4 extra 1-key head lookups per claim at 20% external failures.

Stalls: run 4 had no 40–100 s stall, only bursts of 1–2 s (at most 55 POSTs ≥ 100 ms in one second). One burst measured with journal counters matched one slow journal `fsync` of ~500 ms on the VM disk (27 writes queued); checkpoints caused none. `j: true` stays, so these bursts are a cost of the environment. The long stalls of runs 2 and 3 matched a busy host: with the host load at 7–12, every container used about twice the CPU for the same work.

Known limit: with 20% of external calls failing, the 2 workers use 990 of 1,000 slots, because each retry repeats the 5 s call, and ready events grow from ~210 to ~540.
