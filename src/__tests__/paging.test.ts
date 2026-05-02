import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileQueue } from '../queue.js';
import { uniqueQueueName, makeItems } from './helpers.js';
import type { PageCursor, QueueItem } from '../types.js';

describe('FileQueue — paging', () => {
  let q: FileQueue;

  beforeEach(async () => {
    q = await FileQueue.open(uniqueQueueName());
    await q.enqueue(makeItems(50, 1000));
  });
  afterEach(() => q.close());

  it('returns the requested limit and a nextCursor', async () => {
    const page = await q.page({ status: 'pending', limit: 10 });
    expect(page.items).toHaveLength(10);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBeDefined();
    expect(page.items[0]!.fileKey).toBe('file_000000.dat');
    expect(page.items[9]!.fileKey).toBe('file_000009.dat');
  });

  it('sequential pages cover all items exactly once with no overlap', async () => {
    const seen = new Set<number>();
    let cursor: PageCursor | undefined;
    for (;;) {
      const page = await q.page({
        status: 'pending',
        limit: 7,
        cursor,
      });
      for (const item of page.items) {
        expect(seen.has(item.id)).toBe(false);
        seen.add(item.id);
      }
      if (!page.hasMore) break;
      cursor = page.nextCursor;
    }
    expect(seen.size).toBe(50);
  });

  it('descending order returns items in reverse id order', async () => {
    const page = await q.page({
      status: 'pending',
      direction: 'desc',
      limit: 5,
    });
    expect(page.items[0]!.fileKey).toBe('file_000049.dat');
    expect(page.items[4]!.fileKey).toBe('file_000045.dat');
  });

  it('sortBy=sizeBytes orders by size within status', async () => {
    const ascending: QueueItem[] = [];
    let cursor: PageCursor | undefined;
    for (;;) {
      const page = await q.page({
        status: 'pending',
        sortBy: 'sizeBytes',
        limit: 10,
        cursor,
      });
      ascending.push(...page.items);
      if (!page.hasMore) break;
      cursor = page.nextCursor;
    }
    expect(ascending).toHaveLength(50);
    for (let i = 1; i < ascending.length; i++) {
      expect(ascending[i]!.sizeBytes).toBeGreaterThanOrEqual(
        ascending[i - 1]!.sizeBytes,
      );
    }
  });

  it('sortBy=fileKey sorts alphabetically within status', async () => {
    const page = await q.page({
      status: 'pending',
      sortBy: 'fileKey',
      limit: 5,
    });
    const keys = page.items.map((i) => i.fileKey);
    expect(keys).toEqual([...keys].sort());
  });

  it('rejects sortBy != id when no status is given', async () => {
    await expect(q.page({ sortBy: 'sizeBytes', limit: 10 })).rejects.toThrow();
  });

  it('without status filter, paging spans all statuses', async () => {
    await q.claimNext(5);
    const all = (await q.page({ limit: 1000 })).items;
    expect(all).toHaveLength(50);
    expect(all.filter((i) => i.status === 'started')).toHaveLength(5);
    expect(all.filter((i) => i.status === 'pending')).toHaveLength(45);
  });

  it('iterate() yields every item exactly once', async () => {
    const seen: number[] = [];
    await q.iterate({ status: 'pending', batchSize: 13 }, (batch) => {
      for (const item of batch) seen.push(item.id);
    });
    expect(seen.length).toBe(50);
    expect(new Set(seen).size).toBe(50);
  });

  it('empty page returns hasMore=false and no cursor', async () => {
    const page = await q.page({ status: 'completed', limit: 10 });
    expect(page.items).toEqual([]);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeUndefined();
  });
});
