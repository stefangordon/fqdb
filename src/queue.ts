import {
  AGGREGATES,
  IDX_FILEKEY,
  IDX_STATUS_ID,
  IDX_STATUS_KEY,
  IDX_STATUS_SIZE,
  ITEMS,
  dbName,
  deleteDb,
  lockName,
  openDb,
  reqToPromise,
  txToPromise,
} from './db.js';
import {
  FqdbError,
  ItemNotFoundError,
  QueueClosedError,
  QueueLockedError,
} from './errors.js';
import {
  applyDelta,
  readAllBuckets,
  sumBuckets,
} from './aggregates.js';
import {
  acquireWriterLock,
  isLockHeld,
  type LockHandle,
} from './lock.js';
import type {
  EnqueueOptions,
  EnqueueResult,
  IterateOptions,
  NewItem,
  OpenOptions,
  PageOptions,
  PageResult,
  QueueItem,
  Stats,
  Status,
} from './types.js';

const DEFAULT_PAGE_LIMIT = 100;
const DEFAULT_BATCH_SIZE = 1000;
const DEFAULT_ENQUEUE_CHUNK = 5000;

/**
 * A persistent, indexed file queue backed by IndexedDB with cross-tab
 * single-writer election via the Web Locks API.
 *
 * Open with `FileQueue.open(name)`. The first tab to open a queue with a given
 * name becomes the writer; subsequent tabs are read-only and any write operation
 * throws `QueueLockedError`.
 */
export class FileQueue {
  private closed = false;

  private constructor(
    public readonly name: string,
    private readonly db: IDBDatabase,
    private readonly lockHandle: LockHandle,
  ) {
    db.onclose = (): void => {
      this.closed = true;
    };
  }

  /**
   * Open (or create) a named queue.
   *
   * - The first tab to call `open(name)` becomes the writer.
   * - Subsequent tabs become readers (writer methods throw `QueueLockedError`).
   * - Pass `{ requireWriter: true }` to throw instead of becoming a reader.
   * - On writer election, leftover `started` items revert to `pending` with
   *   `attempts++` (assumes a previous writer crashed mid-transfer). Disable
   *   with `{ skipRecovery: true }`.
   */
  static async open(
    name: string,
    opts: OpenOptions = {},
  ): Promise<FileQueue> {
    if (!name || /[/:]/.test(name)) {
      throw new FqdbError(
        `Invalid queue name "${name}" (must be non-empty, no slashes or colons)`,
      );
    }

    const lockHandle = await acquireWriterLock(lockName(name));
    if (opts.requireWriter && !lockHandle.isWriter) {
      lockHandle.release();
      throw new QueueLockedError(
        `Queue "${name}" is already owned by another tab`,
      );
    }

    let db: IDBDatabase;
    try {
      db = await openDb(dbName(name));
    } catch (err) {
      lockHandle.release();
      throw err;
    }

    if (!opts.skipPersist) {
      try {
        await navigator.storage?.persist?.();
      } catch {
        // persist() may fail in private mode or restricted contexts; ignore.
      }
    }

    const queue = new FileQueue(name, db, lockHandle);

    if (lockHandle.isWriter && !opts.skipRecovery) {
      await queue.recoverStarted();
    }

    return queue;
  }

  /** True if this tab holds the writer lock. */
  get isWriter(): boolean {
    return this.lockHandle.isWriter;
  }

  /** True until `close()` is called or the underlying connection is lost. */
  get isOpen(): boolean {
    return !this.closed;
  }

  /**
   * Close the underlying IndexedDB connection and release the writer lock
   * if held. After calling this, the queue cannot be used.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
    this.lockHandle.release();
  }

  /**
   * Permanently delete this queue's IndexedDB database. Closes the queue first.
   * Only callable from the writer tab; throws otherwise.
   */
  async destroy(): Promise<void> {
    this.assertWriter();
    const name = this.name;
    await this.close();
    await deleteDb(dbName(name));
  }

  // --------------------------------------------------------------------------
  // Read-only methods (callable from any tab)
  // --------------------------------------------------------------------------

  /**
   * Count items in the queue, optionally filtered by status.
   * O(1) regardless of queue size.
   */
  async count(status?: Status): Promise<number> {
    this.assertOpen();
    const tx = this.db.transaction(AGGREGATES, 'readonly');
    const aggs = tx.objectStore(AGGREGATES);
    const buckets = await readAllBuckets(aggs);
    await txToPromise(tx);
    if (status !== undefined) return buckets[status].count;
    return sumBuckets(...Object.values(buckets)).count;
  }

  /**
   * Read per-status counts and byte totals. O(1) regardless of queue size.
   */
  async stats(): Promise<Stats> {
    this.assertOpen();
    const tx = this.db.transaction(AGGREGATES, 'readonly');
    const aggs = tx.objectStore(AGGREGATES);
    const buckets = await readAllBuckets(aggs);
    await txToPromise(tx);
    return {
      pending: buckets.pending,
      started: buckets.started,
      completed: buckets.completed,
      failed: buckets.failed,
      cancelled: buckets.cancelled,
      total: sumBuckets(...Object.values(buckets)),
    };
  }

  /** Get a single item by id, or undefined if not found. */
  async get(id: number): Promise<QueueItem | undefined> {
    this.assertOpen();
    const tx = this.db.transaction(ITEMS, 'readonly');
    const items = tx.objectStore(ITEMS);
    const result = await reqToPromise<QueueItem | undefined>(
      items.get(id) as IDBRequest<QueueItem | undefined>,
    );
    await txToPromise(tx);
    return result;
  }

  /** Test whether any item with the given fileKey exists in the queue. */
  async has(fileKey: string): Promise<boolean> {
    this.assertOpen();
    const tx = this.db.transaction(ITEMS, 'readonly');
    const idx = tx.objectStore(ITEMS).index(IDX_FILEKEY);
    const result = await reqToPromise<number>(idx.count(fileKey));
    await txToPromise(tx);
    return result > 0;
  }

  /**
   * Read a page of items via keyset pagination. Scales to 10M+ items.
   *
   * Default sort is `id` ascending (= insertion order, FIFO). When `status` is
   * omitted, only `sortBy: 'id'` is supported. With a `status` filter, you can
   * sort by `id`, `sizeBytes`, or `fileKey`.
   *
   * To page: pass the returned `nextCursor` to the next call.
   */
  async page(opts: PageOptions = {}): Promise<PageResult> {
    this.assertOpen();
    const {
      status,
      sortBy = 'id',
      direction = 'asc',
      cursor,
      limit = DEFAULT_PAGE_LIMIT,
    } = opts;

    if (status === undefined && sortBy !== 'id') {
      throw new FqdbError(
        `page(): when no status filter is given, sortBy must be 'id' (got '${sortBy}')`,
      );
    }
    if (limit <= 0) return { items: [], hasMore: false };

    const cursorDirection: IDBCursorDirection =
      direction === 'asc' ? 'next' : 'prev';
    const tx = this.db.transaction(ITEMS, 'readonly');
    const items = tx.objectStore(ITEMS);

    return new Promise<PageResult>((resolve, reject) => {
      const result: QueueItem[] = [];
      let lastKey: IDBValidKey | undefined;
      let lastPk: number | undefined;
      let firstSeek = false;
      let cursorReq: IDBRequest<IDBCursorWithValue | null>;

      if (status === undefined) {
        let range: IDBKeyRange | undefined;
        if (cursor) {
          range =
            direction === 'asc'
              ? IDBKeyRange.lowerBound(cursor.primaryKey + 1)
              : IDBKeyRange.upperBound(cursor.primaryKey - 1);
        }
        cursorReq = items.openCursor(range, cursorDirection);
      } else {
        const indexName =
          sortBy === 'sizeBytes'
            ? IDX_STATUS_SIZE
            : sortBy === 'fileKey'
              ? IDX_STATUS_KEY
              : IDX_STATUS_ID;
        const idx = items.index(indexName);
        const range = IDBKeyRange.bound([status], [status, []], false, true);
        cursorReq = idx.openCursor(range, cursorDirection);
        firstSeek = !!cursor;
      }

      cursorReq.onerror = (): void => reject(cursorReq.error);
      cursorReq.onsuccess = (): void => {
        const c = cursorReq.result;
        if (!c) {
          resolve({ items: result, hasMore: false });
          return;
        }

        if (firstSeek && cursor) {
          firstSeek = false;
          const nextPk =
            direction === 'asc'
              ? cursor.primaryKey + 1
              : cursor.primaryKey - 1;
          c.continuePrimaryKey(cursor.indexKey, nextPk);
          return;
        }

        if (result.length >= limit) {
          resolve({
            items: result,
            hasMore: true,
            nextCursor: { indexKey: lastKey!, primaryKey: lastPk! },
          });
          return;
        }

        const item = c.value as QueueItem;
        result.push(item);
        lastKey = status === undefined ? item.id : c.key;
        lastPk = item.id;
        c.continue();
      };
    });
  }

  /**
   * Iterate every matching item in batches. Use this for bulk processing
   * where you can't hold the whole result set in memory.
   */
  async iterate(
    opts: IterateOptions,
    onBatch: (batch: QueueItem[]) => void | Promise<void>,
  ): Promise<void> {
    this.assertOpen();
    const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
    let cursor: PageOptions['cursor'];
    for (;;) {
      const page = await this.page({
        status: opts.status,
        sortBy: 'id',
        direction: 'asc',
        cursor,
        limit: batchSize,
      });
      if (page.items.length === 0) return;
      await onBatch(page.items);
      if (!page.hasMore || !page.nextCursor) return;
      cursor = page.nextCursor;
    }
  }

  // --------------------------------------------------------------------------
  // Writer-only methods
  // --------------------------------------------------------------------------

  /**
   * Add items to the queue. Accepts arbitrarily large arrays; chunked
   * internally into multi-thousand-item transactions for throughput.
   *
   * Pass `skipDuplicates: true` to silently drop items whose `fileKey` is
   * already in the queue. The default allows duplicates (cheaper).
   */
  async enqueue(
    newItems: ReadonlyArray<NewItem>,
    opts: EnqueueOptions = {},
  ): Promise<EnqueueResult> {
    this.assertWriter();
    if (newItems.length === 0) {
      return { added: 0, skipped: 0, ids: [] };
    }

    const chunkSize = opts.chunkSize ?? DEFAULT_ENQUEUE_CHUNK;
    const skipDuplicates = !!opts.skipDuplicates;

    const ids: number[] = [];
    let added = 0;
    let skipped = 0;

    for (let offset = 0; offset < newItems.length; offset += chunkSize) {
      const chunk = newItems.slice(offset, offset + chunkSize);
      const tx = this.db.transaction([ITEMS, AGGREGATES], 'readwrite');
      const items = tx.objectStore(ITEMS);
      const aggs = tx.objectStore(AGGREGATES);
      const fileKeyIdx = items.index(IDX_FILEKEY);

      // For throughput at 10M scale: issue all IDB requests up front on the
      // same transaction (the IDB engine processes them in order without JS
      // round-trips between them), then await results in a single Promise.all.

      let dupMask: boolean[] = [];
      if (skipDuplicates) {
        const countReqs = chunk.map((it) => fileKeyIdx.count(it.fileKey));
        const counts = await Promise.all(
          countReqs.map((r) => reqToPromise<number>(r)),
        );
        dupMask = counts.map((c) => c > 0);
        skipped += dupMask.filter(Boolean).length;
      }

      let chunkBytes = 0;
      const addReqs: IDBRequest<IDBValidKey>[] = [];

      for (let i = 0; i < chunk.length; i++) {
        if (dupMask[i]) continue;
        const newItem = chunk[i]!;
        const sizeBytes = newItem.sizeBytes ?? 0;
        const record: Omit<QueueItem, 'id'> = {
          fileKey: newItem.fileKey,
          status: 'pending',
          sizeBytes,
          bytesTransferred: 0,
          attempts: 0,
          ...(newItem.meta !== undefined ? { meta: newItem.meta } : {}),
        };
        addReqs.push(items.add(record));
        chunkBytes += sizeBytes;
      }

      if (addReqs.length > 0) {
        const newIds = await Promise.all(
          addReqs.map((r) => reqToPromise<IDBValidKey>(r)),
        );
        for (const id of newIds) ids.push(id as number);
        await applyDelta(aggs, 'pending', addReqs.length, chunkBytes, 0);
      }

      await txToPromise(tx);
      added += addReqs.length;
    }

    return { added, skipped, ids };
  }

  /**
   * Atomically claim the next N pending items. Items move from `pending` to
   * `started`. Returns up to `n` items in FIFO order (by id).
   */
  async claimNext(n = 1): Promise<QueueItem[]> {
    this.assertWriter();
    if (n <= 0) return [];

    const tx = this.db.transaction([ITEMS, AGGREGATES], 'readwrite');
    const items = tx.objectStore(ITEMS);
    const aggs = tx.objectStore(AGGREGATES);
    const idx = items.index(IDX_STATUS_ID);
    const range = IDBKeyRange.bound(
      ['pending'],
      ['pending', []],
      false,
      true,
    );

    const claimed: QueueItem[] = [];
    let claimedBytes = 0;
    let claimedXfer = 0;

    await new Promise<void>((resolve, reject) => {
      const req = idx.openCursor(range);
      req.onerror = (): void => reject(req.error);
      req.onsuccess = (): void => {
        const c = req.result;
        if (!c || claimed.length >= n) {
          resolve();
          return;
        }
        const item = c.value as QueueItem;
        item.status = 'started';
        c.update(item);
        claimed.push(item);
        claimedBytes += item.sizeBytes;
        claimedXfer += item.bytesTransferred;
        c.continue();
      };
    });

    if (claimed.length > 0) {
      await applyDelta(
        aggs,
        'pending',
        -claimed.length,
        -claimedBytes,
        0,
      );
      await applyDelta(aggs, 'started', claimed.length, claimedBytes, claimedXfer);
    }

    await txToPromise(tx);
    return claimed;
  }

  /**
   * Update the bytesTransferred on a `started` item. Aggregate `started.bytesTransferred`
   * is updated atomically.
   *
   * Throws if the item is not in `started` state.
   */
  async updateProgress(id: number, bytesTransferred: number): Promise<void> {
    this.assertWriter();
    if (!Number.isFinite(bytesTransferred) || bytesTransferred < 0) {
      throw new FqdbError(`Invalid bytesTransferred: ${bytesTransferred}`);
    }
    const tx = this.db.transaction([ITEMS, AGGREGATES], 'readwrite');
    const items = tx.objectStore(ITEMS);
    const aggs = tx.objectStore(AGGREGATES);
    const item = await reqToPromise<QueueItem | undefined>(
      items.get(id) as IDBRequest<QueueItem | undefined>,
    );
    if (!item) throw new ItemNotFoundError(id);
    if (item.status !== 'started') {
      throw new FqdbError(
        `updateProgress(${id}): item is in '${item.status}' state, expected 'started'`,
      );
    }
    const delta = bytesTransferred - item.bytesTransferred;
    item.bytesTransferred = bytesTransferred;
    await reqToPromise(items.put(item));
    if (delta !== 0) {
      await applyDelta(aggs, 'started', 0, 0, delta);
    }
    await txToPromise(tx);
  }

  /**
   * Mark an item as completed. Sets `bytesTransferred` to `sizeBytes`.
   * Throws if the item is not in `started` state.
   */
  async complete(id: number): Promise<void> {
    this.assertWriter();
    await this.transition(id, 'started', 'completed', (item) => {
      const delta = item.sizeBytes - item.bytesTransferred;
      item.bytesTransferred = item.sizeBytes;
      return { bytesTransferredDelta: delta, completed: true };
    });
  }

  /**
   * Mark an item as failed. Pass `retry: true` to send it back to `pending`
   * with `attempts++` instead of moving to the failed terminal state.
   */
  async fail(
    id: number,
    error: string,
    opts: { retry?: boolean } = {},
  ): Promise<void> {
    this.assertWriter();
    const target: Status = opts.retry ? 'pending' : 'failed';
    await this.transition(id, 'started', target, (item) => {
      item.error = error;
      if (opts.retry) item.attempts += 1;
      return {};
    });
  }

  /**
   * Cancel items. Items currently in `pending` or `started` move to `cancelled`.
   * Items already in a terminal state are left alone.
   */
  async cancel(ids: number[]): Promise<{ cancelled: number }> {
    this.assertWriter();
    if (ids.length === 0) return { cancelled: 0 };
    const tx = this.db.transaction([ITEMS, AGGREGATES], 'readwrite');
    const items = tx.objectStore(ITEMS);
    const aggs = tx.objectStore(AGGREGATES);
    let cancelled = 0;
    const fromDeltas: Record<Status, { count: number; bytes: number; xfer: number }> = {
      pending: { count: 0, bytes: 0, xfer: 0 },
      started: { count: 0, bytes: 0, xfer: 0 },
      completed: { count: 0, bytes: 0, xfer: 0 },
      failed: { count: 0, bytes: 0, xfer: 0 },
      cancelled: { count: 0, bytes: 0, xfer: 0 },
    };
    let toBytes = 0;
    let toXfer = 0;

    for (const id of ids) {
      const item = await reqToPromise<QueueItem | undefined>(
        items.get(id) as IDBRequest<QueueItem | undefined>,
      );
      if (!item) continue;
      if (item.status !== 'pending' && item.status !== 'started') continue;
      const from = item.status;
      fromDeltas[from].count += 1;
      fromDeltas[from].bytes += item.sizeBytes;
      fromDeltas[from].xfer += item.bytesTransferred;
      item.status = 'cancelled';
      await reqToPromise(items.put(item));
      cancelled += 1;
      toBytes += item.sizeBytes;
      toXfer += item.bytesTransferred;
    }

    for (const s of ['pending', 'started'] as const) {
      const d = fromDeltas[s];
      if (d.count > 0) {
        await applyDelta(aggs, s, -d.count, -d.bytes, s === 'started' ? -d.xfer : 0);
      }
    }
    if (cancelled > 0) {
      await applyDelta(aggs, 'cancelled', cancelled, toBytes, toXfer);
    }
    await txToPromise(tx);
    return { cancelled };
  }

  /**
   * Delete all items in the given status, or every item if no status given.
   * Aggregates are updated atomically.
   */
  async clear(status?: Status): Promise<{ deleted: number }> {
    this.assertWriter();
    const tx = this.db.transaction([ITEMS, AGGREGATES], 'readwrite');
    const items = tx.objectStore(ITEMS);
    const aggs = tx.objectStore(AGGREGATES);
    let deleted = 0;
    let bytes = 0;
    let xfer = 0;
    const xferStatuses: Status[] = ['started'];

    if (status === undefined) {
      const buckets = await readAllBuckets(aggs);
      await reqToPromise(items.clear());
      for (const s of Object.keys(buckets) as Status[]) {
        await applyDelta(
          aggs,
          s,
          -buckets[s].count,
          -buckets[s].bytes,
          -buckets[s].bytesTransferred,
        );
      }
      deleted = Object.values(buckets).reduce((n, b) => n + b.count, 0);
      bytes = Object.values(buckets).reduce((n, b) => n + b.bytes, 0);
      xfer = Object.values(buckets).reduce((n, b) => n + b.bytesTransferred, 0);
    } else {
      const idx = items.index(IDX_STATUS_ID);
      const range = IDBKeyRange.bound([status], [status, []], false, true);
      await new Promise<void>((resolve, reject) => {
        const req = idx.openCursor(range);
        req.onerror = (): void => reject(req.error);
        req.onsuccess = (): void => {
          const c = req.result;
          if (!c) {
            resolve();
            return;
          }
          const item = c.value as QueueItem;
          deleted += 1;
          bytes += item.sizeBytes;
          xfer += item.bytesTransferred;
          c.delete();
          c.continue();
        };
      });
      if (deleted > 0) {
        const xferDelta = xferStatuses.includes(status) ? -xfer : 0;
        await applyDelta(aggs, status, -deleted, -bytes, xferDelta);
      }
    }
    await txToPromise(tx);
    return { deleted };
  }

  // --------------------------------------------------------------------------
  // Internal helpers
  // --------------------------------------------------------------------------

  private async transition(
    id: number,
    from: Status,
    to: Status,
    mutate: (item: QueueItem) => {
      bytesTransferredDelta?: number;
      completed?: boolean;
    },
  ): Promise<void> {
    const tx = this.db.transaction([ITEMS, AGGREGATES], 'readwrite');
    const items = tx.objectStore(ITEMS);
    const aggs = tx.objectStore(AGGREGATES);
    const item = await reqToPromise<QueueItem | undefined>(
      items.get(id) as IDBRequest<QueueItem | undefined>,
    );
    if (!item) throw new ItemNotFoundError(id);
    if (item.status !== from) {
      throw new FqdbError(
        `transition(${id}): item is in '${item.status}', expected '${from}'`,
      );
    }
    const sizeBytes = item.sizeBytes;
    const xferBefore = item.bytesTransferred;
    const result = mutate(item);
    item.status = to;
    await reqToPromise(items.put(item));

    // From-bucket loses one item (and its progress, if it was 'started').
    await applyDelta(
      aggs,
      from,
      -1,
      -sizeBytes,
      from === 'started' ? -xferBefore : 0,
    );
    // To-bucket gains one (with bytesTransferred only meaningful if it's 'started';
    // for all other targets we don't track xfer, so contribute 0).
    const xferToContribute = to === 'started' ? item.bytesTransferred : 0;
    await applyDelta(aggs, to, 1, sizeBytes, xferToContribute);

    void result;
    await txToPromise(tx);
  }

  private async recoverStarted(): Promise<void> {
    const tx = this.db.transaction([ITEMS, AGGREGATES], 'readwrite');
    const items = tx.objectStore(ITEMS);
    const aggs = tx.objectStore(AGGREGATES);
    const idx = items.index(IDX_STATUS_ID);
    const range = IDBKeyRange.bound(
      ['started'],
      ['started', []],
      false,
      true,
    );

    let recovered = 0;
    let bytes = 0;
    let xfer = 0;

    await new Promise<void>((resolve, reject) => {
      const req = idx.openCursor(range);
      req.onerror = (): void => reject(req.error);
      req.onsuccess = (): void => {
        const c = req.result;
        if (!c) {
          resolve();
          return;
        }
        const item = c.value as QueueItem;
        item.status = 'pending';
        item.attempts += 1;
        c.update(item);
        recovered += 1;
        bytes += item.sizeBytes;
        xfer += item.bytesTransferred;
        c.continue();
      };
    });

    if (recovered > 0) {
      await applyDelta(aggs, 'started', -recovered, -bytes, -xfer);
      await applyDelta(aggs, 'pending', recovered, bytes, 0);
    }

    await txToPromise(tx);
  }

  private assertOpen(): void {
    if (this.closed) throw new QueueClosedError();
  }

  private assertWriter(): void {
    this.assertOpen();
    if (!this.lockHandle.isWriter) throw new QueueLockedError();
  }
}

/**
 * Returns true if any tab currently holds the writer lock for the named queue.
 * Useful for showing UI like "another tab is the writer" before calling open().
 */
export async function isQueueLocked(name: string): Promise<boolean> {
  return isLockHeld(lockName(name));
}
