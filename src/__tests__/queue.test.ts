import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileQueue } from '../queue.js';
import {
  ItemNotFoundError,
  QueueClosedError,
  QueueLockedError,
} from '../errors.js';
import {
  clearLockMock,
  makeItems,
  mockAsReader,
  uniqueQueueName,
} from './helpers.js';

describe('FileQueue — open and basic state', () => {
  afterEach(clearLockMock);

  it('opens as writer when no other tab holds the lock', async () => {
    const q = await FileQueue.open(uniqueQueueName());
    expect(q.isWriter).toBe(true);
    expect(q.isOpen).toBe(true);
    await q.close();
    expect(q.isOpen).toBe(false);
  });

  it('rejects invalid queue names', async () => {
    await expect(FileQueue.open('')).rejects.toThrow();
    await expect(FileQueue.open('bad/name')).rejects.toThrow();
    await expect(FileQueue.open('bad:name')).rejects.toThrow();
  });

  it('throws QueueLockedError when requireWriter and lock is held', async () => {
    mockAsReader();
    await expect(
      FileQueue.open(uniqueQueueName(), { requireWriter: true }),
    ).rejects.toBeInstanceOf(QueueLockedError);
  });

  it('opens as reader when lock is held by another tab', async () => {
    mockAsReader();
    const q = await FileQueue.open(uniqueQueueName());
    expect(q.isWriter).toBe(false);
    await q.close();
  });

  it('all writer methods throw QueueLockedError on a reader', async () => {
    mockAsReader();
    const q = await FileQueue.open(uniqueQueueName());
    await expect(q.enqueue([{ fileKey: 'x' }])).rejects.toBeInstanceOf(
      QueueLockedError,
    );
    await expect(q.claimNext()).rejects.toBeInstanceOf(QueueLockedError);
    await expect(q.complete(1)).rejects.toBeInstanceOf(QueueLockedError);
    await expect(q.fail(1, 'err')).rejects.toBeInstanceOf(QueueLockedError);
    await expect(q.cancel([1])).rejects.toBeInstanceOf(QueueLockedError);
    await expect(q.clear()).rejects.toBeInstanceOf(QueueLockedError);
    await expect(q.updateProgress(1, 100)).rejects.toBeInstanceOf(
      QueueLockedError,
    );
    await q.close();
  });

  it('any method throws QueueClosedError after close', async () => {
    const q = await FileQueue.open(uniqueQueueName());
    await q.close();
    await expect(q.count()).rejects.toBeInstanceOf(QueueClosedError);
    await expect(q.stats()).rejects.toBeInstanceOf(QueueClosedError);
    await expect(q.enqueue([{ fileKey: 'x' }])).rejects.toBeInstanceOf(
      QueueClosedError,
    );
  });
});

describe('FileQueue — enqueue and stats', () => {
  let q: FileQueue;
  beforeEach(async () => {
    q = await FileQueue.open(uniqueQueueName());
  });
  afterEach(async () => {
    await q.close();
  });

  it('enqueues a single item with default size 0', async () => {
    const result = await q.enqueue([{ fileKey: 'a' }]);
    expect(result.added).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.ids).toHaveLength(1);
    const item = await q.get(result.ids[0]!);
    expect(item).toMatchObject({
      fileKey: 'a',
      status: 'pending',
      sizeBytes: 0,
      bytesTransferred: 0,
      attempts: 0,
    });
  });

  it('enqueues many items in a chunked transaction and reports stats', async () => {
    const items = makeItems(2500, 100);
    const result = await q.enqueue(items, { chunkSize: 1000 });
    expect(result.added).toBe(2500);
    const stats = await q.stats();
    expect(stats.pending.count).toBe(2500);
    expect(stats.pending.bytes).toBe(
      items.reduce((s, x) => s + (x.sizeBytes ?? 0), 0),
    );
    expect(stats.total.count).toBe(2500);
    expect(stats.started.count).toBe(0);
  });

  it('skipDuplicates respects existing fileKey index', async () => {
    await q.enqueue([
      { fileKey: 'a', sizeBytes: 10 },
      { fileKey: 'b', sizeBytes: 20 },
    ]);
    const result = await q.enqueue(
      [
        { fileKey: 'a', sizeBytes: 99 },
        { fileKey: 'c', sizeBytes: 30 },
      ],
      { skipDuplicates: true },
    );
    expect(result.added).toBe(1);
    expect(result.skipped).toBe(1);
    expect(await q.has('a')).toBe(true);
    expect(await q.has('c')).toBe(true);
    expect((await q.stats()).pending.count).toBe(3);
  });

  it('count() and stats() are O(1) and consistent', async () => {
    await q.enqueue(makeItems(10, 100));
    expect(await q.count()).toBe(10);
    expect(await q.count('pending')).toBe(10);
    expect(await q.count('completed')).toBe(0);

    const claimed = await q.claimNext(3);
    expect(claimed).toHaveLength(3);
    expect(await q.count('pending')).toBe(7);
    expect(await q.count('started')).toBe(3);

    await q.complete(claimed[0]!.id);
    expect(await q.count('completed')).toBe(1);
    expect(await q.count('started')).toBe(2);
  });
});

describe('FileQueue — claim/complete/fail/cancel/clear', () => {
  let q: FileQueue;
  beforeEach(async () => {
    q = await FileQueue.open(uniqueQueueName());
    await q.enqueue(makeItems(10, 100));
  });
  afterEach(async () => {
    await q.close();
  });

  it('claimNext returns FIFO order', async () => {
    const claimed = await q.claimNext(3);
    expect(claimed.map((i) => i.fileKey)).toEqual([
      'file_000000.dat',
      'file_000001.dat',
      'file_000002.dat',
    ]);
    expect(claimed.every((i) => i.status === 'started')).toBe(true);
  });

  it('claimNext returns fewer items than requested if queue is short', async () => {
    const all = await q.claimNext(100);
    expect(all).toHaveLength(10);
    expect((await q.stats()).pending.count).toBe(0);
  });

  it('complete moves started -> completed and sets bytesTransferred = sizeBytes', async () => {
    const [item] = await q.claimNext(1);
    await q.updateProgress(item!.id, 50);
    await q.complete(item!.id);
    const got = await q.get(item!.id);
    expect(got!.status).toBe('completed');
    expect(got!.bytesTransferred).toBe(got!.sizeBytes);
    const stats = await q.stats();
    expect(stats.completed.count).toBe(1);
    expect(stats.started.count).toBe(0);
    expect(stats.started.bytesTransferred).toBe(0);
  });

  it('fail moves started -> failed and records error', async () => {
    const [item] = await q.claimNext(1);
    await q.fail(item!.id, 'network error');
    const got = await q.get(item!.id);
    expect(got!.status).toBe('failed');
    expect(got!.error).toBe('network error');
    expect((await q.stats()).failed.count).toBe(1);
  });

  it('fail with retry sends item back to pending and bumps attempts', async () => {
    const [item] = await q.claimNext(1);
    await q.fail(item!.id, 'transient', { retry: true });
    const got = await q.get(item!.id);
    expect(got!.status).toBe('pending');
    expect(got!.attempts).toBe(1);
    expect(got!.error).toBe('transient');
    expect((await q.stats()).failed.count).toBe(0);
    expect((await q.stats()).pending.count).toBe(10);
  });

  it('complete throws if item is not started', async () => {
    const ids = (await q.page({ status: 'pending', limit: 1 })).items;
    await expect(q.complete(ids[0]!.id)).rejects.toThrow(
      /expected 'started'/,
    );
  });

  it('complete throws ItemNotFoundError for unknown id', async () => {
    await expect(q.complete(99_999)).rejects.toBeInstanceOf(
      ItemNotFoundError,
    );
  });

  it('cancel moves pending and started items to cancelled', async () => {
    const claimed = await q.claimNext(2);
    const pendingIds = (await q.page({ status: 'pending', limit: 3 })).items.map(
      (i) => i.id,
    );
    const allIds = [...claimed.map((c) => c.id), ...pendingIds];
    const result = await q.cancel(allIds);
    expect(result.cancelled).toBe(5);
    const stats = await q.stats();
    expect(stats.cancelled.count).toBe(5);
    expect(stats.pending.count).toBe(10 - 2 - 3);
    expect(stats.started.count).toBe(0);
  });

  it('cancel skips items already in terminal state', async () => {
    const [item] = await q.claimNext(1);
    await q.complete(item!.id);
    const result = await q.cancel([item!.id]);
    expect(result.cancelled).toBe(0);
    expect((await q.get(item!.id))!.status).toBe('completed');
  });

  it('clear(status) deletes only items in that status', async () => {
    await q.claimNext(3);
    const result = await q.clear('pending');
    expect(result.deleted).toBe(7);
    const stats = await q.stats();
    expect(stats.pending.count).toBe(0);
    expect(stats.started.count).toBe(3);
    expect(stats.total.count).toBe(3);
  });

  it('clear() with no status deletes everything and zeroes aggregates', async () => {
    await q.claimNext(3);
    await q.clear();
    const stats = await q.stats();
    expect(stats.total.count).toBe(0);
    expect(stats.total.bytes).toBe(0);
    expect(stats.total.bytesTransferred).toBe(0);
  });
});

describe('FileQueue — byte progress', () => {
  let q: FileQueue;
  beforeEach(async () => {
    q = await FileQueue.open(uniqueQueueName());
    await q.enqueue([
      { fileKey: 'big.bin', sizeBytes: 1_000_000 },
      { fileKey: 'med.bin', sizeBytes: 500_000 },
    ]);
  });
  afterEach(() => q.close());

  it('updateProgress reflects in started.bytesTransferred aggregate', async () => {
    const claimed = await q.claimNext(2);
    const [a, b] = claimed;
    await q.updateProgress(a!.id, 250_000);
    await q.updateProgress(b!.id, 100_000);
    const stats = await q.stats();
    expect(stats.started.count).toBe(2);
    expect(stats.started.bytes).toBe(1_500_000);
    expect(stats.started.bytesTransferred).toBe(350_000);
  });

  it('updateProgress accepts decreasing values (delta is signed)', async () => {
    const [item] = await q.claimNext(1);
    await q.updateProgress(item!.id, 500_000);
    await q.updateProgress(item!.id, 200_000);
    const stats = await q.stats();
    expect(stats.started.bytesTransferred).toBe(200_000);
  });

  it('updateProgress rejects negative or non-finite values', async () => {
    const [item] = await q.claimNext(1);
    await expect(q.updateProgress(item!.id, -1)).rejects.toThrow();
    await expect(q.updateProgress(item!.id, Number.NaN)).rejects.toThrow();
  });

  it('updateProgress throws if item is not in started state', async () => {
    const item = (await q.page({ status: 'pending', limit: 1 })).items[0]!;
    await expect(q.updateProgress(item.id, 100)).rejects.toThrow(
      /expected 'started'/,
    );
  });

  it('complete sets bytesTransferred to sizeBytes regardless of prior progress', async () => {
    const [item] = await q.claimNext(1);
    await q.updateProgress(item!.id, 100_000);
    await q.complete(item!.id);
    const got = await q.get(item!.id);
    expect(got!.bytesTransferred).toBe(got!.sizeBytes);
  });
});

describe('FileQueue — recovery on writer election', () => {
  it('reverts started -> pending with attempts++ on reopen', async () => {
    const name = uniqueQueueName();
    const q1 = await FileQueue.open(name);
    await q1.enqueue([
      { fileKey: 'a', sizeBytes: 100 },
      { fileKey: 'b', sizeBytes: 200 },
    ]);
    const claimed = await q1.claimNext(2);
    await q1.updateProgress(claimed[0]!.id, 50);
    await q1.close();

    const q2 = await FileQueue.open(name);
    const stats = await q2.stats();
    expect(stats.started.count).toBe(0);
    expect(stats.pending.count).toBe(2);
    expect(stats.started.bytesTransferred).toBe(0);
    const items = (await q2.page({ status: 'pending', limit: 10 })).items;
    expect(items.every((i) => i.attempts === 1)).toBe(true);
    expect(items.find((i) => i.fileKey === 'a')!.bytesTransferred).toBe(50);
    await q2.close();
  });

  it('skipRecovery preserves started state', async () => {
    const name = uniqueQueueName();
    const q1 = await FileQueue.open(name);
    await q1.enqueue([{ fileKey: 'a' }]);
    await q1.claimNext(1);
    await q1.close();

    const q2 = await FileQueue.open(name, { skipRecovery: true });
    const stats = await q2.stats();
    expect(stats.started.count).toBe(1);
    expect(stats.pending.count).toBe(0);
    await q2.close();
  });
});
