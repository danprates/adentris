import {
  Injectable,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, mongo } from 'mongoose';
import { CreateEventDto } from './dto/create-event.dto';
import { dedupKey } from './dedup-key';
import { Event, EventStatus } from './schemas/event.schema';

export interface CreateEventResult {
  id: string;
  status: EventStatus;
  duplicate: boolean;
}

const DUPLICATE_KEY = 11000;

@Injectable()
export class EventsService implements OnModuleInit {
  constructor(@InjectModel(Event.name) private readonly events: Model<Event>) {}

  // The unique dedupKey index must exist before the first insert, or concurrent duplicates slip in.
  async onModuleInit(): Promise<void> {
    await this.events.init();
  }

  // B1: no backlog limit at the door; we accept while Mongo writes.
  // Refusing would push the load back to senders and trigger mass retries.
  async create(dto: CreateEventDto): Promise<CreateEventResult> {
    const key = dedupKey(dto);
    const now = new Date();
    try {
      // j: true before the 202: an accepted event is on the journal and survives a crash.
      const doc = await new this.events({
        ...dto,
        dedupKey: key,
        receivedAt: now,
        availableAt: now,
      }).save({ j: true });
      return { id: doc.id as string, status: doc.status, duplicate: false };
    } catch (err) {
      if (err instanceof mongo.MongoServerError && err.code === DUPLICATE_KEY) {
        const original = await this.events
          .findOne({ dedupKey: key }, { status: 1 })
          .orFail()
          .lean();
        return {
          id: original._id.toString(),
          status: original.status,
          duplicate: true,
        };
      }
      // 503 instead of waiting: the sender retries and the dedupKey covers the retry.
      // The 2s limit is the connection's timeoutMS (see app.module.ts).
      if (err instanceof mongo.MongoOperationTimeoutError) {
        throw new ServiceUnavailableException('Event store timed out, retry');
      }
      throw err;
    }
  }
}
