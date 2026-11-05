import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import { Model, mongo, Types } from 'mongoose';
import { patientRef } from '../common/patient-ref';
import { Event } from '../events/schemas/event.schema';
import { ExternalProcessorService } from './external-processor.service';
import { processingConfig } from './processing.config';
import { isExhausted, nextAttemptAt } from './retry-policy';

export type ClaimedEvent = Event & { _id: Types.ObjectId };

const DUPLICATE_KEY = 11000;

const errorMessage = (err: unknown) =>
  err instanceof Error ? err.message : String(err);
// Ready events read per claim; enough distinct patients to find a free one.
const CLAIM_BATCH = 100;

@Injectable()
export class ProcessingService implements OnModuleInit {
  // Identifies this process as the lease owner; unique per instance, so two workers never share it.
  readonly workerId = randomUUID();
  private readonly logger = new Logger('WideEvent');

  constructor(
    @InjectModel(Event.name) private readonly events: Model<Event>,
    private readonly external: ExternalProcessorService,
    @Inject(processingConfig.KEY)
    private readonly config: ConfigType<typeof processingConfig>,
  ) {}

  // The partial unique index on patientId must exist before the first claim, or the per-patient lock is off.
  async onModuleInit(): Promise<void> {
    await this.events.init();
  }

  // Claims the head (lowest ts, then _id) of one patient with ready work; null when none is free.
  async claim(): Promise<ClaimedEvent | null> {
    const now = new Date();
    // Events queued behind a busy patient are the oldest ready ones and would fill the batch, so each claim
    // walked dozens of busy heads (load test: ~100 claims/s for 167/s). Cost: 1 more query per claim.
    const busy: string[] = await this.events.distinct('patientId', {
      status: 'processing',
    });
    const ready = await this.events
      .find(
        {
          status: 'pending',
          availableAt: { $lte: now },
          patientId: { $nin: busy },
        },
        // No _id: it isn't in the index, so asking for it would fetch every scanned document.
        { _id: 0, patientId: 1 },
      )
      .sort({ availableAt: 1 })
      .limit(CLAIM_BATCH)
      .lean();
    for (const patientId of new Set(ready.map((e) => e.patientId))) {
      // Only the patient's head (lowest ts among pending and processing) is claimed; later events wait,
      // even while the head runs or waits for a retry, so a head released mid-claim never gets overtaken.
      const head = await this.events
        .findOne(
          { patientId, status: { $in: ['pending', 'processing'] } },
          { status: 1, availableAt: 1 },
        )
        // _id breaks a ts tie in insert order for one api; across api replicas the ObjectIds come from
        // different processes, so the tie order is arbitrary. Cost: equal-ts events of a patient may swap.
        .sort({ ts: 1, _id: 1 })
        .lean();
      if (!head || head.status !== 'pending' || head.availableAt > now) {
        continue;
      }
      try {
        const claimed = await this.events
          .findOneAndUpdate(
            { _id: head._id, status: 'pending' },
            // $$NOW is Mongo's clock: the reaper compares against the same one, so worker clock skew cannot
            // expire a live lease early. Cost: a pipeline update instead of plain $set/$inc.
            [
              {
                $set: {
                  status: 'processing',
                  leaseOwner: this.workerId,
                  leaseUntil: { $add: ['$$NOW', this.config.leaseMs] },
                  attempts: { $add: ['$attempts', 1] },
                },
              },
            ],
            { new: true },
          )
          .lean();
        // null: another worker claimed it first.
        if (claimed) {
          return claimed;
        }
      } catch (err) {
        // 11000: the patient already has an event in processing.
        if (!(
          err instanceof mongo.MongoServerError && err.code === DUPLICATE_KEY
        )) {
          throw err;
        }
      }
    }
    return null;
  }

  // Calls the external API and stores the result. Never throws: the outcome goes to one wide event.
  async handle(event: ClaimedEvent): Promise<void> {
    const wideEvent: Record<string, unknown> = {
      eventId: event._id.toString(),
      patientRef: patientRef(event.patientId),
      attempt: event.attempts,
    };
    // A failed write leaves the event in processing until its lease expires; the reaper counts it as an attempt.
    const writeFailed = (err: unknown) => {
      wideEvent.writeError = errorMessage(err);
      return 'write_failed';
    };
    try {
      let reprocessed: number;
      try {
        reprocessed = await this.resetLater(event);
      } catch (err) {
        wideEvent.outcome = writeFailed(err);
        return;
      }
      if (reprocessed > 0) {
        wideEvent.late = true;
        wideEvent.reprocessed = reprocessed;
      }
      const start = performance.now();
      let result: Record<string, unknown>;
      try {
        result = await this.callExternal(event);
      } catch (err) {
        // Only an external error goes to the retry policy; a failed write below does not.
        wideEvent.externalMs = Math.round(performance.now() - start);
        const error = errorMessage(err);
        wideEvent.error = error;
        wideEvent.outcome = await this.fail(event, error).then(
          (outcome) => outcome ?? 'lease_lost',
          writeFailed,
        );
        return;
      }
      wideEvent.externalMs = Math.round(performance.now() - start);
      wideEvent.outcome = await this.complete(event, result).then(
        (done) => (done ? 'done' : 'lease_lost'),
        writeFailed,
      );
    } finally {
      this.logger.log(wideEvent);
    }
  }

  // A result depends on the events before it, so a late event sends the later done ones back
  // to the queue and the head claim redoes them in ts order. Cost: extra external calls, with no cap; the
  // api's 7-day ts window bounds one reprocess.
  // Safe without a transaction: we hold the patient's lock, and if a crash cuts the updateMany short,
  // the late event's next claim runs it again and resets the rest.
  private async resetLater(event: ClaimedEvent): Promise<number> {
    const { modifiedCount } = await this.events.updateMany(
      // Only done goes back: pending is already queued, and failed waits for an operator.
      { patientId: event.patientId, status: 'done', ts: { $gt: event.ts } },
      {
        // attempts restart at 0: a reprocess is a new run and gets its full retries, not the ones its earlier
        // run spent. Cost: attempts counts only the current run, so the total external calls are not stored.
        $set: { status: 'pending', availableAt: new Date(), attempts: 0 },
        // Each reprocess calls the external API with a new key (dedupKey:reprocessCount);
        // in our Mongo the event stays 1 document.
        $inc: { reprocessCount: 1 },
      },
    );
    return modifiedCount;
  }

  private callExternal(event: ClaimedEvent): Promise<Record<string, unknown>> {
    // The timeout stays below the lease (checked at boot); otherwise 2 workers process the same event.
    const signal = AbortSignal.timeout(this.config.externalTimeoutMs);
    return Promise.race([
      this.external.process(
        event,
        `${event.dedupKey}:${event.reprocessCount}`,
        signal,
      ),
      // Also ends a call that ignores the signal, so a hung API never holds the event past the timeout.
      new Promise<never>((_, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason as Error)),
      ),
    ]);
  }

  // The lease is this claim's: leaseOwner names the process and (reprocessCount, attempts) the claim, since
  // attempts restart at 0 on reprocess; a stale handle never overwrites a later claim, even by this worker.
  private ownLease(event: ClaimedEvent) {
    return {
      _id: event._id,
      status: 'processing',
      leaseOwner: this.workerId,
      attempts: event.attempts,
      reprocessCount: event.reprocessCount,
    };
  }

  private async complete(
    event: ClaimedEvent,
    result: Record<string, unknown>,
  ): Promise<boolean> {
    const { modifiedCount } = await this.events.updateOne(
      this.ownLease(event),
      {
        $set: { status: 'done', result, processedAt: new Date() },
        $unset: { leaseOwner: 1, leaseUntil: 1, error: 1 },
      },
    );
    return modifiedCount === 1;
  }

  // Schedules the next attempt, or gives up after the last one; null when the lease was lost.
  private async fail(
    event: ClaimedEvent,
    error: string,
  ): Promise<'retry' | 'failed' | null> {
    // failed does not block the patient: holding them forever for 1 bad event is worse.
    // Trade-off: later events are processed on a state that lacks this event.
    const outcome = isExhausted(event.attempts) ? 'failed' : 'retry';
    const { modifiedCount } = await this.events.updateOne(
      this.ownLease(event),
      {
        $set:
          outcome === 'failed'
            ? { status: 'failed', error }
            : {
                status: 'pending',
                error,
                availableAt: nextAttemptAt(
                  event.attempts,
                  this.config.retryBaseMs,
                ),
              },
        $unset: { leaseOwner: 1, leaseUntil: 1 },
      },
    );
    return modifiedCount === 1 ? outcome : null;
  }
}
