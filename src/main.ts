import { NestFactory } from '@nestjs/core';
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { createAdapter, setupApp } from './app.setup';
import { logHashKey } from './common/patient-ref';

async function bootstrap() {
  logHashKey();
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    createAdapter(),
    { bufferLogs: true },
  );
  setupApp(app);
  // SIGTERM closes Fastify, which stops taking connections and lets in-flight requests finish.
  // Node as PID 1 ignores SIGTERM without a handler, so without this Docker waits and sends SIGKILL.
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3000, '0.0.0.0');
}
void bootstrap();
