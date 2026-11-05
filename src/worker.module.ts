import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { ScheduleModule } from '@nestjs/schedule';
import { ProcessingModule } from './processing/processing.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        uri: config.getOrThrow<string>('MONGO_URI'),
        // A stalled Mongo would hold the claim's await forever and freeze the dispatch loop; this makes it throw,
        // so the loop logs and retries. Cost: a query slower than 5 s fails, and the reaper takes the event back.
        timeoutMS: 5_000,
      }),
    }),
    ScheduleModule.forRoot(),
    ProcessingModule,
  ],
})
export class WorkerModule {}
