/**
 * Minimal p-limit: caps how many of the given async tasks run at once.
 * Excess tasks queue and start as running ones settle.
 */
export type LimitFn = <T>(task: () => Promise<T>) => Promise<T>;

export function pLimit(concurrency: number): LimitFn {
  if (concurrency < 1 || !Number.isFinite(concurrency)) {
    throw new RangeError(`concurrency must be a positive number, got ${concurrency}`);
  }

  let active = 0;
  const queue: Array<() => void> = [];

  const next = (): void => {
    active--;
    queue.shift()?.();
  };

  return <T>(task: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const run = (): void => {
        active++;
        task().then(resolve, reject).finally(next);
      };
      if (active < concurrency) {
        run();
      } else {
        queue.push(run);
      }
    });
}
