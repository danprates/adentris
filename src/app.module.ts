import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { EventsModule } from './events/events.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        uri: config.getOrThrow<string>('MONGO_URI'),
        // Driver-level timeout for every operation: Mongoose's save() drops a per-operation timeoutMS.
        // An insert slower than 2s fails and becomes a 503 (see EventsService).
        timeoutMS: 2000,
      }),
    }),
    EventsModule,
    HealthModule,
  ],
})
export class AppModule {}
