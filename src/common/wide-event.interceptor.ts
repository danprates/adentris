import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Observable, tap } from 'rxjs';

// One JSON log line per request, emitted at the end with all its context.
@Injectable()
export class WideEventInterceptor implements NestInterceptor {
  private readonly logger = new Logger('WideEvent');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();
    const start = performance.now();
    const body = req.body as { patientId?: unknown } | undefined;
    const base = {
      method: req.method,
      route: req.routeOptions.url,
      patientId: body?.patientId,
    };
    const durationMs = () => Math.round(performance.now() - start);

    return next.handle().pipe(
      tap({
        next: (result: { id?: string } | undefined) =>
          this.logger.log({
            ...base,
            status: reply.statusCode,
            durationMs: durationMs(),
            eventId: result?.id,
            // POST /events answers 200 only for a duplicate (202 for a new event).
            duplicate: result?.id ? reply.statusCode === 200 : undefined,
          }),
        error: (err: unknown) =>
          this.logger.log({
            ...base,
            status: err instanceof HttpException ? err.getStatus() : 500,
            durationMs: durationMs(),
            error: errorMessage(err),
          }),
      }),
    );
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof HttpException) {
    const res = err.getResponse();
    const message =
      typeof res === 'string' ? res : (res as { message?: unknown }).message;
    return Array.isArray(message) ? message.join('; ') : String(message);
  }
  return err instanceof Error ? err.message : String(err);
}
