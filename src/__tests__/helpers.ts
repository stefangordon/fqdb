import type { NewItem } from '../types.js';

let counter = 0;

export function uniqueQueueName(prefix = 'test'): string {
  counter += 1;
  return `${prefix}_${Date.now()}_${counter}_${Math.random().toString(36).slice(2, 8)}`;
}

export function makeItem(i: number, sizeBytes = 1024): NewItem {
  return {
    fileKey: `file_${i.toString().padStart(6, '0')}.dat`,
    sizeBytes,
  };
}

export function makeItems(n: number, baseSize = 1024): NewItem[] {
  return Array.from({ length: n }, (_, i) => makeItem(i, baseSize + i));
}

interface ReaderLocks {
  locks: {
    request: (
      name: string,
      opts: { mode?: string; ifAvailable?: boolean },
      cb: (lock: null) => unknown,
    ) => Promise<unknown>;
    query?: () => Promise<{ held?: { name: string }[] }>;
  };
}

/**
 * Replace navigator.locks with a mock that always reports "lock held by
 * another tab" (callback receives null). Tests calling FileQueue.open() after
 * this will become readers.
 */
export function mockAsReader(): void {
  (globalThis as { navigator: ReaderLocks }).navigator = {
    locks: {
      request: (_name, _opts, cb) => Promise.resolve(cb(null)),
      query: () => Promise.resolve({ held: [] }),
    },
  };
}

export function clearLockMock(): void {
  delete (globalThis as { navigator?: unknown }).navigator;
}
