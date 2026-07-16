import { describe, expect, it } from 'vitest';
import { pLimit } from '../../src/utils/concurrency.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('pLimit', () => {
  it('rejects invalid concurrency', () => {
    expect(() => pLimit(0)).toThrow(RangeError);
    expect(() => pLimit(Number.NaN)).toThrow(RangeError);
  });

  it('never runs more than the limit concurrently', async () => {
    const limit = pLimit(2);
    let active = 0;
    let maxActive = 0;

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        limit(async () => {
          active++;
          maxActive = Math.max(maxActive, active);
          await new Promise((r) => setTimeout(r, 5));
          active--;
          return i;
        }),
      ),
    );

    expect(maxActive).toBe(2);
    expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('starts queued tasks as slots free up', async () => {
    const limit = pLimit(1);
    const first = deferred<void>();
    const order: string[] = [];

    const p1 = limit(async () => {
      order.push('start-1');
      await first.promise;
      order.push('end-1');
    });
    const p2 = limit(async () => {
      order.push('start-2');
    });

    // Second task must not start while the first is pending.
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(['start-1']);

    first.resolve();
    await Promise.all([p1, p2]);
    expect(order).toEqual(['start-1', 'end-1', 'start-2']);
  });

  it('propagates rejections without blocking the queue', async () => {
    const limit = pLimit(1);
    const failing = limit(async () => {
      throw new Error('boom');
    });
    const following = limit(async () => 'ok');

    await expect(failing).rejects.toThrow('boom');
    await expect(following).resolves.toBe('ok');
  });
});
