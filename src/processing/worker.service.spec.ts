import { Logger } from '@nestjs/common';
import { ClaimedEvent, ProcessingService } from './processing.service';
import { WorkerService } from './worker.service';

const event = { patientId: 'p-1' } as ClaimedEvent;

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}
function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe('WorkerService', () => {
  let claim: jest.Mock<Promise<ClaimedEvent | null>, []>;
  let handle: jest.Mock<Promise<void>, [ClaimedEvent]>;
  let worker: WorkerService;

  const start = (concurrency = 3) => {
    worker = new WorkerService(
      { claim, handle } as unknown as ProcessingService,
      {
        concurrency,
        leaseMs: 30_000,
        externalTimeoutMs: 10_000,
        processingDelayMs: 5_000,
      },
    );
    worker.onApplicationBootstrap();
  };

  const shutdown = async () => {
    const done = worker.beforeApplicationShutdown();
    await jest.advanceTimersByTimeAsync(10_000);
    await done;
  };

  beforeEach(() => {
    jest.useFakeTimers();
    claim = jest.fn<Promise<ClaimedEvent | null>, []>();
    handle = jest.fn<Promise<void>, [ClaimedEvent]>();
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await shutdown();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('2.U1 keeps at most `concurrency` handles in flight', async () => {
    claim.mockResolvedValue(event);
    handle.mockReturnValue(new Promise(() => undefined));
    start(3);

    await jest.advanceTimersByTimeAsync(1000);

    expect(handle).toHaveBeenCalledTimes(3);
    expect(claim).toHaveBeenCalledTimes(3);
  });

  it('2.U2 claims again when a handle finishes', async () => {
    const first = deferred();
    claim.mockResolvedValue(event);
    handle
      .mockReturnValueOnce(first.promise)
      .mockReturnValue(new Promise(() => undefined));
    start(3);
    await jest.advanceTimersByTimeAsync(100);
    expect(claim).toHaveBeenCalledTimes(3);

    first.resolve();
    await jest.advanceTimersByTimeAsync(100);

    expect(claim).toHaveBeenCalledTimes(4);
    expect(handle).toHaveBeenCalledTimes(4);
  });

  it('2.U3 polls an empty queue once per second', async () => {
    claim.mockResolvedValue(null);
    start();

    await jest.advanceTimersByTimeAsync(5000);

    // Calls at 0s, 1s, ..., 5s.
    expect(claim.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect(claim.mock.calls.length).toBeLessThanOrEqual(6);
    expect(handle).not.toHaveBeenCalled();
  });

  it('2.U4 frees the slot when a handle throws', async () => {
    claim.mockResolvedValue(event);
    handle
      .mockRejectedValueOnce(new Error('boom'))
      .mockReturnValue(new Promise(() => undefined));
    start(1);

    await jest.advanceTimersByTimeAsync(200);

    expect(handle).toHaveBeenCalledTimes(2);
  });

  it('2.U5 survives a claim error and processes the event on retry', async () => {
    claim
      .mockRejectedValueOnce(new Error('mongo down'))
      .mockResolvedValueOnce(event)
      .mockResolvedValue(null);
    handle.mockResolvedValue();
    start();

    await jest.advanceTimersByTimeAsync(500);
    expect(handle).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(600);

    expect(handle).toHaveBeenCalledWith(event);
  });

  it('2.U6 shutdown stops claiming and waits for in-flight handles', async () => {
    const handles = [deferred(), deferred()];
    claim
      .mockResolvedValueOnce(event)
      .mockResolvedValueOnce(event)
      .mockResolvedValue(null);
    handle
      .mockReturnValueOnce(handles[0].promise)
      .mockReturnValueOnce(handles[1].promise);
    start();
    await jest.advanceTimersByTimeAsync(10);
    const claimsBefore = claim.mock.calls.length;

    let finished = false;
    const done = worker
      .beforeApplicationShutdown()
      .then(() => (finished = true));
    await jest.advanceTimersByTimeAsync(3000);
    expect(finished).toBe(false);
    expect(claim).toHaveBeenCalledTimes(claimsBefore);

    handles[0].resolve();
    await jest.advanceTimersByTimeAsync(10);
    expect(finished).toBe(false);
    handles[1].resolve();
    await jest.advanceTimersByTimeAsync(10);
    await done;

    expect(finished).toBe(true);
    expect(claim).toHaveBeenCalledTimes(claimsBefore);
  });

  it('2.U7 shutdown gives up after 10s', async () => {
    claim.mockResolvedValueOnce(event).mockResolvedValue(null);
    handle.mockReturnValue(new Promise(() => undefined));
    start();
    await jest.advanceTimersByTimeAsync(10);

    let finished = false;
    void worker.beforeApplicationShutdown().then(() => (finished = true));
    await jest.advanceTimersByTimeAsync(9_999);
    expect(finished).toBe(false);
    await jest.advanceTimersByTimeAsync(1);

    expect(finished).toBe(true);
  });
});
