import { NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import { createApi } from './helpers';

describe('App (e2e)', () => {
  let app: NestFastifyApplication;

  beforeEach(async () => {
    app = await createApi();
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET /health returns 200 with status ok', () => {
    return request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect((res) => expect(res.body).toMatchObject({ status: 'ok' }));
  });
});
