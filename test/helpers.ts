import { ConsoleLogger, INestApplicationContext } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, TestingModule } from '@nestjs/testing';
import { Collection, Connection } from 'mongoose';
import { AppModule } from '../src/app.module';
import { createAdapter, setupApp } from '../src/app.setup';
import { ExternalProcessorService } from '../src/processing/external-processor.service';
import { WorkerModule } from '../src/worker.module';

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

export interface WorkerOptions {
  env?: Record<string, string>;
  external?: Pick<ExternalProcessorService, 'process'>;
}

// Boots the worker like worker.ts does; env applies only while the config is built.
export async function createWorker({
  env = {},
  external,
}: WorkerOptions = {}): Promise<TestingModule> {
  const saved = Object.keys(env).map((key) => [key, process.env[key]] as const);
  Object.assign(process.env, env);
  try {
    let builder = Test.createTestingModule({ imports: [WorkerModule] });
    if (external) {
      builder = builder
        .overrideProvider(ExternalProcessorService)
        .useValue(external);
    }
    const worker = await builder.compile();
    worker.useLogger(new ConsoleLogger({ json: true }));
    await worker.init();
    return worker;
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error(`waitFor: condition not met in ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export function eventsCollection(app: INestApplicationContext): Collection {
  return app.get<Connection>(getConnectionToken()).collection('events');
}

// deleteMany keeps the indexes; dropping the collection would force rebuilding them per test.
export async function clearEvents(app: INestApplicationContext): Promise<void> {
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
    wideEvents: <T = WideEvent>(): T[] =>
      lines()
        .filter((entry) => entry.context === 'WideEvent')
        .map((entry) => entry.message as T),
    restore: () => spies.forEach((spy) => spy.mockRestore()),
  };
}
