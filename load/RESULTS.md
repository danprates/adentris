# Load test results

Setup: one laptop (Docker Desktop VM with 8 vCPU and 8 GB) runs k6, the api, 2 workers × 500 slots and a single-node Mongo. The run lasts 10 min at 167 req/s, with 5000 patients, 10% duplicates and `ts` up to 30s in the past. At minute 3 one worker gets SIGKILL (`load/chaos.sh`).

| Metric | Run 1 (before fix) | Run 2 | Run 3 (final) |
| --- | --- | --- | --- |
| Requests / `accepted_new` / duplicates (200) | 100,201 / 90,246 / 9,955 | 99,092 / 89,251 / 9,828 | 99,928 / 89,885 / 10,043 |
| k6 p50 / p95 / p99 / max | 1.5 / 3.2 / 12 ms / 272 ms | 1.6 / 6.7 / 686 ms / 6.0 s | 2.1 / 20.5 / 370 ms / 2.3 s |
| Failed requests | 0 | 13 (503, store timeout) | 0 |
| Server p99 outside the stall window | — | 10 ms | 42 ms |
| Peak pending / oldest pending age | 34k and growing / 236 s | 1,289 / 65 s | 2,209 / 52 s |
| `verify --final` | not run (queue never drained) | PASS | PASS |

Final verify (run 3): 89,885 documents = `accepted_new`, 0 lost, 0 pending, 0 failed, 0 duplicate `dedupKey`, 0 out of order. 11,851 events arrived after an event with a later `ts`. Worker wide events show 9,610 late events, which sent 10,316 done events back to the queue (`reprocessCount` total: 10,355). In steady state 830–870 events are in processing (theory: 834), about 220 are pending, and the oldest pending event waits 15–25 s behind its busy patient.

Recovery after the kill: the worker is back in 1 s. Its ~440 in-flight events stay locked until the lease expires and the reaper runs (≤ 40 s). Pending got back to its baseline 85 s after the kill (run 2) and 105 s after it (run 3). The theoretical estimate is ~200 s: 40 s of outage, cleared at 20% headroom (5×).

Fix found by run 1: the claim read the 100 oldest ready events, and those were mostly events queued behind busy patients. Each claim walked ~50 busy heads, so throughput stalled at ~100 claims/s against 167/s needed, and the queue grew without limit. The claim now leaves busy patients out of the batch (`fix: leave busy patients out of the claim batch`).

Open: p99 < 100 ms fails in runs 2 and 3. Each run has a 40–100 s stall: Mongo 350–430% CPU, all containers spike together (VM ~660% of 800%), and journal waits reach 0.5 s. Run 3's stall started at the worker crash. Run 2's had no visible trigger. Outside the stalls the server p99 is 10–42 ms. The stalls look like the shared laptop saturating, but that is not proven.
