import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { Event, EventSchema } from '../events/schemas/event.schema';
import { ExternalProcessorService } from './external-processor.service';
import { LeaseReaperService } from './lease-reaper.service';
import { processingConfig } from './processing.config';
import { ProcessingService } from './processing.service';
import { WorkerService } from './worker.service';

@Module({
  imports: [
    ConfigModule.forFeature(processingConfig),
    MongooseModule.forFeature([{ name: Event.name, schema: EventSchema }]),
  ],
  providers: [
    ExternalProcessorService,
    LeaseReaperService,
    ProcessingService,
    WorkerService,
  ],
})
export class ProcessingModule {}
