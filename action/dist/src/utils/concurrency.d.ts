/**
 * Minimal p-limit: caps how many of the given async tasks run at once.
 * Excess tasks queue and start as running ones settle.
 */
export type LimitFn = <T>(task: () => Promise<T>) => Promise<T>;
export declare function pLimit(concurrency: number): LimitFn;
//# sourceMappingURL=concurrency.d.ts.map