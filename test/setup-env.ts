// e2e tests use their own database so they never touch the dev data.
process.env.MONGO_URI = 'mongodb://localhost:27017/ingest_test';
process.env.LOG_HASH_KEY = 'e2e-log-hash-key';
