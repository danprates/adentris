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
  dedupKey?: string;
  duplicate?: boolean;
  error?: string;
}

interface LogLine {
  context?: string;
  message: unknown;
}

// Captures stdout and stderr (where ConsoleLogger writes JSON lines) and parses them.
export function captureLogs() {
  const chunks: string[] = [];
  const capture = (chunk: string | Uint8Array) => {
    chunks.push(chunk.toString());
    return true;
  };
  const spies = [
    jest.spyOn(process.stdout, 'write').mockImplementation(capture),
    jest.spyOn(process.stderr, 'write').mockImplementation(capture),
  ];
  const lines = (): LogLine[] =>
    chunks
      .join('')
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as LogLine);
  return {
    lines,
    wideEvents: (): WideEvent[] =>
      lines()
        .filter((entry) => entry.context === 'WideEvent')
        .map((entry) => entry.message as WideEvent),
    restore: () => spies.forEach((spy) => spy.mockRestore()),
  };
}
