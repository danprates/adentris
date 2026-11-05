import {
  ArgumentMetadata,
  BadRequestException,
  Injectable,
  PipeTransform,
} from '@nestjs/common';

// Mongo refuses a document nested past its depth limit, and that error is a 500 the sender retries forever.
// Cost: a body nested deeper than 20 levels gets 400.
export const MAX_BODY_DEPTH = 20;

// Runs before ValidationPipe: class-transformer walks the body recursively and overflows the stack
// on a 64KB body nested thousands of levels deep, which would be a 500.
@Injectable()
export class MaxDepthPipe implements PipeTransform {
  transform(value: unknown, { type }: ArgumentMetadata): unknown {
    if (type === 'body' && deeperThan(value, MAX_BODY_DEPTH)) {
      throw new BadRequestException(
        `body must be nested at most ${MAX_BODY_DEPTH} levels deep`,
      );
    }
    return value;
  }
}

// Stops at the limit, so the check itself never recurses deeper than it.
function deeperThan(value: unknown, levels: number): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (levels === 0) return true;
  return Object.values(value).some((v) => deeperThan(v, levels - 1));
}
