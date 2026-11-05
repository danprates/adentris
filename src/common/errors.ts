import { mongo } from 'mongoose';

const DUPLICATE_KEY = 11000;

// A Mongo server message can quote the document (field paths of data, the key of an E11000), so logs get
// only its name and code. Cost: to read the full text, an operator reproduces the error.
export function errorMessage(err: unknown): string {
  if (isMongoServerError(err)) return `${err.name} ${String(err.code)}`;
  return err instanceof Error ? err.message : String(err);
}

export function isMongoServerError(
  err: unknown,
): err is mongo.MongoServerError {
  return err instanceof mongo.MongoServerError;
}

// E11000: a unique index refused the write.
export function isDuplicateKey(err: unknown): boolean {
  return isMongoServerError(err) && err.code === DUPLICATE_KEY;
}
