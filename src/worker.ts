import { ConsoleLogger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { logHashKey } from './common/patient-ref';
import { WorkerModule } from './worker.module';

async function bootstrap() {
  logHashKey();
  // No HTTP server: the worker only reads and writes Mongo. This also runs onApplicationBootstrap.
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    bufferLogs: true,
  });
  app.useLogger(new ConsoleLogger({ json: true }));
  // SIGTERM runs beforeApplicationShutdown, which drains the in-flight events.
  app.enableShutdownHooks();
}
void bootstrap();
