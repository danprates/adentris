import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import { Model, mongo, Types } from 'mongoose';
import { Event } from '../events/schemas/event.schema';
import { processingConfig } from './processing.config';

export type ClaimedEvent = Event & { _id: Types.ObjectId };

const DUPLICATE_KEY = 11000;
// Ready events read per claim; enough distinct patients to find a free one.
const CLAIM_BATCH = 100;

@Injectable()
export class ProcessingService implements OnModuleInit {
  // Identifies this process as the lease owner; unique per instance, so two workers never share it.
  readonly workerId = randomUUID();

  constructor(
    @InjectModel(Event.name) private readonly events: Model<Event>,
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
      // Only the patient's head is claimed; later events wait, even while the head waits for a retry.
      const head = await this.events
        .findOne({ patientId, status: 'pending' }, { availableAt: 1 })
        .sort({ ts: 1, _id: 1 })
        .lean();
      if (!head || head.availableAt > now) continue;
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
}
