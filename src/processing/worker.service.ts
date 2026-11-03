import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { processingConfig } from './processing.config';
import { ProcessingService } from './processing.service';

const IDLE_MS = 1000;
const FULL_MS = 50;

@Injectable()
export class WorkerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(WorkerService.name);
  private readonly inFlight = new Set<Promise<void>>();
  private running = false;
  private loop?: Promise<void>;
  private wake?: () => void;

  constructor(
    private readonly processing: ProcessingService,
    @Inject(processingConfig.KEY)
    private readonly config: ConfigType<typeof processingConfig>,
  ) {}

  onApplicationBootstrap(): void {
    this.running = true;
    this.loop = this.dispatch();
  }

  // One loop claims and a counter (the inFlight set) caps concurrency, instead of N polling loops:
  // an empty queue costs 1 query/s per worker, not 1 per slot. Trade-off: claims run one at a time.
  private async dispatch(): Promise<void> {
    while (this.running) {
      if (this.inFlight.size >= this.config.concurrency) {
        await sleep(FULL_MS);
        continue;
      }
      let event: Awaited<ReturnType<ProcessingService['claim']>>;
      try {
        event = await this.processing.claim();
      } catch (err) {
        // Mongo down: log, wait and try again; the process stays up.
        this.logger.error(`claim failed: ${(err as Error)?.message}`);
        await this.idle();
        continue;
      }
      if (!event) {
        await this.idle();
        continue;
      }
      const task: Promise<void> = this.processing
        .handle(event)
        .catch((err: unknown) =>
          this.logger.error(`handle failed: ${(err as Error)?.message}`),
        )
        .finally(() => {
          this.inFlight.delete(task);
          // A finished event frees its patient, so look for work now instead of after the idle wait.
          this.wake?.();
        });
      this.inFlight.add(task);
    }
  }

  private idle(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, IDLE_MS);
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
