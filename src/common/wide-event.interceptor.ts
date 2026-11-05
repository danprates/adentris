import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Observable, catchError, tap, throwError } from 'rxjs';
import { patientRef } from './patient-ref';

// Handlers add their own fields here; the response body stays the API contract, not a log feed.
export type WideEventRequest = FastifyRequest & {
  wideEvent?: Record<string, unknown>;
};

// One JSON log line per request, emitted at the end with all its context.
// shortcut: requests Fastify rejects before Nest routing (malformed JSON 400, >64KB 413, 404) get no line;
// move this to a Fastify onResponse hook when those must be logged too.
@Injectable()
export class WideEventInterceptor implements NestInterceptor {
  private readonly logger = new Logger('WideEvent');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<WideEventRequest>();
    const reply = http.getResponse<FastifyReply>();
    const start = performance.now();
    const body = req.body as { patientId?: unknown } | undefined;
    const base = {
      method: req.method,
      route: req.routeOptions.url,
      patientRef: patientRef(body?.patientId),
    };
    const durationMs = () => Math.round(performance.now() - start);

    return next.handle().pipe(
      tap(() =>
        this.logger.log({
          ...base,
          ...req.wideEvent,
          status: reply.statusCode,
          durationMs: durationMs(),
        }),
      ),
      catchError((err: unknown) => {
        const http = err instanceof HttpException;
        this.logger.log({
          ...base,
          status: http ? err.getStatus() : 500,
          durationMs: durationMs(),
          error: errorMessage(err),
          stack: http ? undefined : (err as Error)?.stack,
        });
        // Nest's exception filter logs unknown errors again; an HttpException keeps it to this one line.
        return throwError(() =>
          http ? err : new InternalServerErrorException(),
        );
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
