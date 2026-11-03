import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { Event, EventSchema } from '../events/schemas/event.schema';
import { ExternalProcessorService } from './external-processor.service';
import { processingConfig } from './processing.config';
import { ProcessingService } from './processing.service';

@Module({
  imports: [
    ConfigModule.forFeature(processingConfig),
    MongooseModule.forFeature([{ name: Event.name, schema: EventSchema }]),
  ],
  providers: [ExternalProcessorService, ProcessingService],
})
export class ProcessingModule {}
