export interface WorkQueue {
  enqueue<T>(fn: () => Promise<T>): Promise<T>;
  readonly pending: number;
  readonly running: number;
}

export function createQueue(concurrency: number): WorkQueue {
  let running = 0;
  let pending = 0;
  const waiting: Array<() => void> = [];

  async function acquire(): Promise<void> {
    if (running < concurrency) {
      running++;
      return;
    }
    pending++;
    await new Promise<void>((resolve) => waiting.push(resolve));
    pending--;
    running++;
  }

  function release(): void {
    running--;
    const next = waiting.shift();
    if (next) next();
  }

  return {
    async enqueue<T>(fn: () => Promise<T>): Promise<T> {
      await acquire();
      try {
        return await fn();
      } finally {
        release();
      }
    },
    get pending() {
      return pending;
    },
    get running() {
      return running;
    },
  };
}
