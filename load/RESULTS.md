# Load test results

Setup for every run: one laptop (Docker Desktop VM with 8 vCPU and 8 GB) runs k6, the api, 2 workers × 500 slots and a single-node Mongo. Each run below lasts 10 min, with 5,000 patients (the load test now uses 500), 10% duplicates and `ts` up to 30s in the past. At minute 3 one worker gets SIGKILL (`load/chaos.sh`). `docker-compose.yml` caps CPU at Mongo 1.5, api 0.5, each worker 0.5 and k6 0.5 (3.5 of 8 cores).

## Assignment load: 1,000 events/min

Runs A–C used 17 events/s = 1,020 events/min. The load test now sends exactly 1,000 events/min.

| Metric                                       | Run A                           | Run B                            | Run C                           |
| -------------------------------------------- | ------------------------------- | -------------------------------- | ------------------------------- |
| Requests / `accepted_new` / duplicates (200) | 10,200 / 9,145 / 1,055          | 10,201 / 9,165 / 1,036           | 10,201 / 9,192 / 1,009          |
| k6 p50 / p95 / p99 / max                     | 4.5 / 6.6 / **8.0 ms** / 164 ms | 4.4 / 7.6 / **10.9 ms** / 481 ms | 4.5 / 8.1 / **15.2 ms** / 1.5 s |
| Server p50 / p99 / max                       | 3 / 6 ms / 104 ms               | 3 / 8 ms / 200 ms                | 3 / 11 ms / 1.0 s               |
| Failed requests / k6 dropped iterations      | 0 / 0                           | 0 / 0                            | 0 / 0                           |
| Pending avg / max, oldest pending            | not sampled                     | 5 / 10, 13 s                     | 4 / 20, 37 s                    |
| In processing avg / max                      | not sampled                     | 78 / 90                          | 79 / 142                        |
| Average CPU: Mongo / api / each worker       | 20% / 4% / 2–4%                 | 22% / 4% / 3%                    | 26% / 5% / 4%                   |
| Host load average                            | 1.7–2.9                         | 2.6–5.2                          | 3.0–6.5                         |
| `verify --final`                             | PASS                            | PASS                             | PASS                            |

Every final verify: documents = `accepted_new`, 0 lost, 0 pending, 0 failed, 0 duplicate `dedupKey`, 0 out of order. About 135 events per run arrived after an event with a later `ts` and sent about 133 done events back to the queue. The killed worker was back in 1 s. Its in-flight events wait for the lease to expire and the reaper to run, which is why the oldest pending event reached 37 s in run C. Run C's 1.5 s max came while the host load was at its highest (6.5).

Run it:

```bash
docker compose --profile load up --build --attach k6 --attach chaos --attach verify --abort-on-container-failure
```

## Found and changed by load runs

An earlier version of the load test also ran at 10,000 events/min (10× the assignment load) to find limits. What it changed:

- **Bug: busy patients filled the claim batch.** The claim read the 100 oldest ready events, and those were mostly events queued behind busy patients. Throughput stalled at ~100 claims/s against 167/s needed, and the queue grew without limit. The claim now leaves busy patients out of the batch (`fix: leave busy patients out of the claim batch`).
- **Indexes.** The claim batch and head queries are covered by `{status, availableAt, patientId}` and `{patientId, status, ts, _id}`. Documents read per claim: ~4,100 → ~1 (`explain` on 104k events).
- **Caches added, then removed.** Two 200 ms caches in the claim cut Mongo CPU at 10,000 events/min. At 1,000 events/min they saved only 2–3 points of Mongo CPU, so they were removed.
- **Stalls.** Bursts of slow requests (1–2 s) matched one slow journal `fsync` of ~500 ms on the VM disk. `j: true` stays, so these bursts are a cost of the environment.
- **Known limit.** With 20% of external calls failing at 10,000 events/min, the 2 workers used 990 of 1,000 slots, because each retry repeats the 5 s call.
