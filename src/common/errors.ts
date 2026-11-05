import { mongo } from 'mongoose';

const DUPLICATE_KEY = 11000;

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// E11000: a unique index refused the write.
export function isDuplicateKey(err: unknown): boolean {
  return err instanceof mongo.MongoServerError && err.code === DUPLICATE_KEY;
}
