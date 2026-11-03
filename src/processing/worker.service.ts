import {
  BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { processingConfig } from './processing.config';
import { ClaimedEvent, ProcessingService } from './processing.service';

const IDLE_MS = 1000;
const SHUTDOWN_TIMEOUT_MS = 10_000;

@Injectable()
export class WorkerService
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
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

  // Stops claiming and waits for in-flight events, up to 10s (compose stop_grace_period is 15s).
  // What does not finish in time comes back when its lease expires.
  async beforeApplicationShutdown(): Promise<void> {
    this.running = false;
    this.wake?.();
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, SHUTDOWN_TIMEOUT_MS);
    });
    const drain = (async () => {
      await this.loop;
      await Promise.all(this.inFlight);
    })();
    await Promise.race([drain, deadline]);
    clearTimeout(timer);
  }

  // One loop claims and a counter (the inFlight set) caps concurrency, instead of N polling loops:
  // an empty queue costs 1 query/s per worker, not 1 per slot. Trade-off: claims run one at a time.
  private async dispatch(): Promise<void> {
    while (this.running) {
      if (this.inFlight.size < this.config.concurrency) {
        try {
          const event = await this.processing.claim();
          if (event) {
            this.start(event);
            continue;
          }
        } catch (err) {
          // Mongo down: log, wait and try again; the process stays up.
          this.logger.error(`claim failed: ${(err as Error)?.message}`);
        }
      }
      await this.waitForWork();
    }
  }

  private start(event: ClaimedEvent): void {
    const task: Promise<void> = this.processing
      .handle(event)
      .catch((err: unknown) =>
        this.logger.error(`handle failed: ${(err as Error)?.message}`),
      )
      .finally(() => {
        this.inFlight.delete(task);
        this.wake?.();
      });
    this.inFlight.add(task);
  }

  // Waits until an event finishes (it frees a slot and its patient) or IDLE_MS passes, whichever is first.
  private waitForWork(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.wake?.(), IDLE_MS);
      this.wake = () => {
        clearTimeout(timer);
        this.wake = undefined;
        resolve();
      };
    });
  }
}
