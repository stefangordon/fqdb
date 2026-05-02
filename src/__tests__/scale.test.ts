import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileQueue } from '../queue.js';
import { uniqueQueueName } from './helpers.js';

/**
 * Scale tests run against fake-indexeddb, which is intentionally a correctness-
 * focused in-memory simulation rather than a fast IDB. Numbers here are not a
 * benchmark — real Chrome IDB is orders of magnitude faster. These tests verify
 * that the queue stays correct across non-trivial workloads.
 */
describe('FileQueue — scale', () => {
  let q: FileQueue;
  beforeEach(async () => {
    q = await FileQueue.open(uniqueQueueName());
  });
  afterEach(() => q.close());

  it('enqueues 5,000 items, paginates to completion', async () => {
    const items = Array.from({ length: 5_000 }, (_, i) => ({
      fileKey: `f_${i.toString().padStart(6, '0')}`,
      sizeBytes: i + 1,
    }));
    const result = await q.enqueue(items, { chunkSize: 1000 });
    expect(result.added).toBe(5_000);

    const stats = await q.stats();
    expect(stats.pending.count).toBe(5_000);
    expect(stats.pending.bytes).toBe((5_000 * 5_001) / 2);

    let total = 0;
    let cursor;
    for (;;) {
      const page = await q.page({
        status: 'pending',
        limit: 500,
        cursor,
      });
      total += page.items.length;
      if (!page.hasMore) break;
      cursor = page.nextCursor;
    }
    expect(total).toBe(5_000);
  }, 60_000);

  it('aggregates remain consistent across many state transitions', async () => {
    const items = Array.from({ length: 500 }, (_, i) => ({
      fileKey: `x_${i}`,
      sizeBytes: 100,
    }));
    await q.enqueue(items);

    const claimed = await q.claimNext(250);
    for (const item of claimed.slice(0, 100)) {
      await q.complete(item.id);
    }
    for (const item of claimed.slice(100, 150)) {
      await q.fail(item.id, 'oops');
    }
    await q.cancel(claimed.slice(150, 200).map((c) => c.id));
    for (const item of claimed.slice(200)) {
      await q.updateProgress(item.id, 50);
    }

    const stats = await q.stats();
    expect(stats.pending.count).toBe(250);
    expect(stats.started.count).toBe(50);
    expect(stats.started.bytesTransferred).toBe(2500);
    expect(stats.completed.count).toBe(100);
    expect(stats.failed.count).toBe(50);
    expect(stats.cancelled.count).toBe(50);
    expect(stats.total.count).toBe(500);
    expect(stats.total.bytes).toBe(50_000);
  }, 30_000);
});
