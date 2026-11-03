import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { setTimeout } from 'node:timers/promises';
import { processingConfig } from './processing.config';

export interface ExternalInput {
  patientId: string;
  type: string;
  data: Record<string, unknown>;
  ts: Date;
}

// Fake of the external API: it only waits PROCESSING_DELAY_MS and answers.
@Injectable()
export class ExternalProcessorService {
  constructor(
    @Inject(processingConfig.KEY)
    private readonly config: ConfigType<typeof processingConfig>,
  ) {}

  // A1: idempotencyKey = dedupKey:reprocessCount changes on every reprocess, and a real client
  // sends it as the Idempotency-Key header. The API must treat a new key as "recompute and replace", not "add".
  async process(
    event: ExternalInput,
    idempotencyKey: string,
  ): Promise<Record<string, unknown>> {
    // The timeout stays below the lease (checked at boot); otherwise 2 workers process the same event.
    await setTimeout(this.config.processingDelayMs, undefined, {
      signal: AbortSignal.timeout(this.config.externalTimeoutMs),
    });
    return { type: event.type, idempotencyKey };
  }
}
