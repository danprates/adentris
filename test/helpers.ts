import { getConnectionToken } from '@nestjs/mongoose';
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Collection, Connection } from 'mongoose';
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

export function eventsCollection(app: NestFastifyApplication): Collection {
  return app.get<Connection>(getConnectionToken()).collection('events');
}

// deleteMany keeps the indexes; dropping the collection would force rebuilding them per test.
export async function clearEvents(app: NestFastifyApplication): Promise<void> {
  await eventsCollection(app).deleteMany({});
}

export interface WideEvent {
  method: string;
  route: string;
  status: number;
  durationMs: number;
  patientId?: string;
  eventId?: string;
  duplicate?: boolean;
  error?: string;
}

// Captures stdout (where ConsoleLogger writes JSON lines) and returns the wide events seen.
export function captureLogs() {
  const chunks: string[] = [];
  const spy = jest
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: string | Uint8Array) => {
      chunks.push(chunk.toString());
      return true;
    });
  return {
    wideEvents(): WideEvent[] {
      return chunks
        .join('')
        .split('\n')
        .filter((line) => line.startsWith('{'))
        .map(
          (line) => JSON.parse(line) as { context?: string; message: unknown },
        )
        .filter((entry) => entry.context === 'WideEvent')
        .map((entry) => entry.message as WideEvent);
    },
    restore: () => spy.mockRestore(),
  };
}
