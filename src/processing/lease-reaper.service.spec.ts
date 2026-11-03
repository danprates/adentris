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
});
