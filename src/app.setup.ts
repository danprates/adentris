import {
  ConsoleLogger,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { WideEventInterceptor } from './common/wide-event.interceptor';

// Shared by main.ts and the e2e tests so both boot the api with the same configuration.
export function createAdapter(): FastifyAdapter {
  return new FastifyAdapter({ bodyLimit: 64 * 1024 });
}

export function setupApp(app: INestApplication): void {
  app.useLogger(new ConsoleLogger({ json: true }));
  app.useGlobalInterceptors(new WideEventInterceptor());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      // An unknown field is rejected, not silently dropped: dropping it would lose clinical data.
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
}
