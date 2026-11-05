import {
  BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { SchedulerRegistry } from '@nestjs/schedule';
import { Model } from 'mongoose';
import { errorMessage } from '../common/errors';
import { Event } from '../events/schemas/event.schema';
import { processingConfig } from './processing.config';
import { MAX_ATTEMPTS } from './retry-policy';

@Injectable()
export class LeaseReaperService
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(LeaseReaperService.name);
  private tick?: Promise<void>;

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
      setInterval(() => {
        this.tick = this.reap();
      }, this.config.reaperIntervalMs),
    );
  }

  // Runs before the Mongo connection closes on shutdown: stop new ticks and let the one in flight
  // finish, or it fails on a closed client. Cost: shutdown waits for at most 1 updateMany.
  async beforeApplicationShutdown(): Promise<void> {
    this.scheduler.deleteInterval('lease-reaper');
    await this.tick;
  }

  // Runs on every worker: 1 updateMany over expired leases is safe to run at the same time and to repeat.
  async reap(): Promise<void> {
    try {
      const { modifiedCount } = await this.events.updateMany(
        // Mongo's clock, the one the claim set the lease with (see ProcessingService.claim).
        { status: 'processing', $expr: { $lt: ['$leaseUntil', '$$NOW'] } },
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
      this.logger.error(`reap failed: ${errorMessage(err)}`);
    }
  }
}
