// e2e tests use their own database so they never touch the dev data.
process.env.MONGO_URI = 'mongodb://localhost:27017/ingest_test';
process.env.LOG_HASH_KEY = 'e2e-log-hash-key';

// The apps log JSON lines; tests that check them use captureLogs, and the rest would flood the terminal.
for (const stream of [process.stdout, process.stderr]) {
  const write = stream.write.bind(stream) as (...args: unknown[]) => boolean;
  stream.write = (chunk: unknown, ...rest: unknown[]) =>
    String(chunk).startsWith('{"level"') ? true : write(chunk, ...rest);
}
