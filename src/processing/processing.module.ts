import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ExternalProcessorService } from './external-processor.service';
import { processingConfig } from './processing.config';

@Module({
  imports: [ConfigModule.forFeature(processingConfig)],
  providers: [ExternalProcessorService],
})
export class ProcessingModule {}
