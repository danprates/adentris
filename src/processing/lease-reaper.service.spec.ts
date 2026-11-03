import { SchedulerRegistry } from '@nestjs/schedule';
import { Model } from 'mongoose';
import { Event } from '../events/schemas/event.schema';
import { LeaseReaperService } from './lease-reaper.service';
import { processingConfig } from './processing.config';

describe('LeaseReaperService', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('3.U3 only touches processing events whose lease has expired', async () => {
    const now = new Date('2026-11-03T08:00:00Z');
    jest.useFakeTimers({ now });
    const updateMany = jest.fn().mockResolvedValue({ modifiedCount: 0 });
    const reaper = new LeaseReaperService(
      { updateMany } as unknown as Model<Event>,
      processingConfig(),
      new SchedulerRegistry(),
    );

    await reaper.reap();

    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledWith(
      { status: 'processing', leaseUntil: { $lt: now } },
      expect.anything(),
    );
  });

  it('stops ticking and waits for the tick in flight on shutdown', async () => {
    jest.useFakeTimers();
    let finish!: () => void;
    const updateMany = jest.fn(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ modifiedCount: 0 });
        }),
    );
    const reaper = new LeaseReaperService(
      { updateMany } as unknown as Model<Event>,
      { ...processingConfig(), reaperIntervalMs: 100 },
      new SchedulerRegistry(),
    );
    reaper.onApplicationBootstrap();
    jest.advanceTimersByTime(100);
    expect(updateMany).toHaveBeenCalledTimes(1);

    let closed = false;
    const shutdown = reaper.beforeApplicationShutdown().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    finish();
    await shutdown;

    jest.advanceTimersByTime(1000);
    expect(updateMany).toHaveBeenCalledTimes(1);
  });
});
