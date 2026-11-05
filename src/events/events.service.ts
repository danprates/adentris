import {
  Injectable,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, mongo } from 'mongoose';
import { isDuplicateKey } from '../common/errors';
import { CreateEventDto } from './dto/create-event.dto';
import { dedupKey } from './dedup-key';
import { Event, EventStatus } from './schemas/event.schema';

export interface CreateEventResult {
  id: string;
  status: EventStatus;
  duplicate: boolean;
}

const REQUEST_TIMEOUT_MS = 2000;

@Injectable()
export class EventsService implements OnModuleInit {
  constructor(@InjectModel(Event.name) private readonly events: Model<Event>) {}

  // The unique dedupKey index must exist before the first insert, or concurrent duplicates slip in.
  async onModuleInit(): Promise<void> {
    await this.events.init();
  }

  // No backlog limit: refusing would push the load back to senders and trigger mass retries.
  // Cost: during a worker outage the queue grows and drains only at the spare worker capacity.
  async create(dto: CreateEventDto): Promise<CreateEventResult> {
    try {
      return await this.insertOrFindOriginal(dto, dedupKey(dto));
    } catch (err) {
      // 503 instead of waiting: the dedupKey makes the sender's retry safe. Cost: the sender must retry on 503.
      if (err instanceof mongo.MongoOperationTimeoutError) {
        throw new ServiceUnavailableException('Event store timed out, retry');
      }
      throw err;
    }
  }

  private async insertOrFindOriginal(
    dto: CreateEventDto,
    key: string,
  ): Promise<CreateEventResult> {
    const now = new Date();
    try {
      // j: true before the 202: an accepted event is on the journal and survives a crash.
      // Cost: each insert waits for the journal; a slow fsync stalls the 202s (one of ~500ms seen in a 3-min load run).
      // The driver's insertOne, not save(): save() drops timeoutMS; new Model() still applies schema defaults.
      const doc = new this.events({
        ...dto,
        dedupKey: key,
        receivedAt: now,
        availableAt: now,
      });
      await this.events.collection.insertOne(doc.toObject(), {
        writeConcern: { j: true },
        timeoutMS: REQUEST_TIMEOUT_MS,
      });
      return {
        id: doc._id.toString(),
        status: doc.status,
        duplicate: false,
      };
    } catch (err) {
      // A duplicate is also the retry of a sender whose 202 was lost when the api died after the insert.
      if (!isDuplicateKey(err)) throw err;
    }
    // A resent failed event stays failed and is not queued again; operations requeue it on purpose.
    const original = await this.events
      .findOne(
        { dedupKey: key },
        { status: 1 },
        { timeoutMS: REQUEST_TIMEOUT_MS },
      )
      .orFail()
      .lean();
    return {
      id: original._id.toString(),
      status: original.status,
      duplicate: true,
    };
  }
}
