import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { createAdapter, setupApp } from '../src/app.setup';

export async function createApi(): Promise<NestFastifyApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app =
    moduleRef.createNestApplication<NestFastifyApplication>(createAdapter());
  setupApp(app);
  // A listening server lets supertest reuse it instead of binding one per request.
  await app.listen(0, '127.0.0.1');
  return app;
}
