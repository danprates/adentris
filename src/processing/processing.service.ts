import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import { Model, mongo, Types } from 'mongoose';
import { Event } from '../events/schemas/event.schema';
import { ExternalProcessorService } from './external-processor.service';
import { processingConfig } from './processing.config';

export type ClaimedEvent = Event & { _id: Types.ObjectId };

const DUPLICATE_KEY = 11000;
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
    const ready = await this.events
      .find({ status: 'pending', availableAt: { $lte: now } }, { patientId: 1 })
      .sort({ availableAt: 1 })
      .limit(CLAIM_BATCH)
      .lean();
    const patients = [...new Set(ready.map((e) => e.patientId))];

    for (const patientId of patients) {
      // Only the patient's head (lowest ts among pending and processing) is claimed; later events wait,
      // even while the head runs or waits for a retry, so a head released mid-claim never gets overtaken.
      const head = await this.events
        .findOne(
          { patientId, status: { $in: ['pending', 'processing'] } },
          { status: 1, availableAt: 1 },
        )
        .sort({ ts: 1, _id: 1 })
        .lean();
      if (!head || head.status !== 'pending' || head.availableAt > now) {
        continue;
      }
      try {
        const claimed = await this.events
          .findOneAndUpdate(
            { _id: head._id, status: 'pending' },
            {
              $set: {
                status: 'processing',
                leaseOwner: this.workerId,
                leaseUntil: new Date(now.getTime() + this.config.leaseMs),
              },
              $inc: { attempts: 1 },
            },
            { new: true },
          )
          .lean();
        // null: another worker claimed it first.
        if (claimed) return claimed;
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
      patientId: event.patientId,
      attempt: event.attempts,
    };
    const start = performance.now();
    try {
      const result = await this.callExternal(event);
      wideEvent.externalMs = Math.round(performance.now() - start);
      wideEvent.outcome = (await this.complete(event, result))
        ? 'done'
        : 'lease_lost';
    } catch (err) {
      wideEvent.externalMs ??= Math.round(performance.now() - start);
      wideEvent.error = err instanceof Error ? err.message : String(err);
      wideEvent.outcome = await this.release(event).then(
        (released) => (released ? 'released' : 'lease_lost'),
        () => 'release_failed',
      );
    } finally {
      this.logger.log(wideEvent);
    }
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

  // Filtered by leaseOwner: a worker that lost its lease never overwrites another worker's result.
  private async complete(
    event: ClaimedEvent,
    result: Record<string, unknown>,
  ): Promise<boolean> {
    const { modifiedCount } = await this.events.updateOne(
      { _id: event._id, status: 'processing', leaseOwner: this.workerId },
      {
        $set: { status: 'done', result, processedAt: new Date() },
        $unset: { leaseOwner: 1, leaseUntil: 1 },
      },
    );
    return modifiedCount === 1;
  }

  // shortcut: an error puts the event straight back to pending with no backoff, so a failing API is retried
  // at once and forever; phase 3 replaces this with backoff and a 5-attempt limit.
  // If this write fails too, the event stays in processing until its lease expires (the phase 3 reaper).
  private async release(event: ClaimedEvent): Promise<boolean> {
    const { modifiedCount } = await this.events.updateOne(
      { _id: event._id, status: 'processing', leaseOwner: this.workerId },
      {
        $set: { status: 'pending' },
        $unset: { leaseOwner: 1, leaseUntil: 1 },
      },
    );
    return modifiedCount === 1;
  }
}
