import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { SchedulerRegistry } from '@nestjs/schedule';
import { Model } from 'mongoose';
import { Event } from '../events/schemas/event.schema';
import { processingConfig } from './processing.config';
import { MAX_ATTEMPTS } from './retry-policy';

@Injectable()
export class LeaseReaperService implements OnApplicationBootstrap {
  private readonly logger = new Logger(LeaseReaperService.name);

  constructor(
    @InjectModel(Event.name) private readonly events: Model<Event>,
    @Inject(processingConfig.KEY)
    private readonly config: ConfigType<typeof processingConfig>,
    private readonly scheduler: SchedulerRegistry,
  ) {}

  // Registered here and not with @Interval: the period comes from config, which a decorator cannot read.
  onApplicationBootstrap(): void {
    this.scheduler.addInterval(
      'lease-reaper',
      setInterval(() => void this.reap(), this.config.reaperIntervalMs),
    );
  }

  // Runs on every worker: 1 updateMany over expired leases is safe to run at the same time and to repeat.
  async reap(): Promise<void> {
    try {
      const { modifiedCount } = await this.events.updateMany(
        { status: 'processing', leaseUntil: { $lt: new Date() } },
        [
          {
            $set: {
              // An expired lease counts as an attempt (attempts grew at claim): an event that kills
              // the worker every time turns failed instead of looping forever.
              status: {
                $cond: [
                  { $gte: ['$attempts', MAX_ATTEMPTS] },
                  'failed',
                  'pending',
                ],
              },
              error: 'lease expired',
            },
          },
          { $unset: ['leaseOwner', 'leaseUntil'] },
        ],
      );
      if (modifiedCount > 0) {
        this.logger.warn(`released ${modifiedCount} expired leases`);
      }
    } catch (err) {
      // Mongo down: the next tick tries again.
      this.logger.error(`reap failed: ${(err as Error)?.message}`);
    }
  }
}
