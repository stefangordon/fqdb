import { reqToPromise } from './db.js';
import type { BucketStats, Status } from './types.js';
import { STATUSES } from './types.js';

export const ZERO_BUCKET: BucketStats = Object.freeze({
  count: 0,
  bytes: 0,
  bytesTransferred: 0,
});

export async function getBucket(
  store: IDBObjectStore,
  status: Status,
): Promise<BucketStats> {
  const result = await reqToPromise<BucketStats | undefined>(
    store.get(status) as IDBRequest<BucketStats | undefined>,
  );
  return result ?? { ...ZERO_BUCKET };
}

export async function putBucket(
  store: IDBObjectStore,
  status: Status,
  value: BucketStats,
): Promise<void> {
  await reqToPromise(store.put(value, status));
}

/**
 * Apply a delta to one bucket. Must be called inside a readwrite transaction
 * that includes the aggregates store.
 */
export async function applyDelta(
  store: IDBObjectStore,
  status: Status,
  countDelta: number,
  bytesDelta: number,
  bytesTransferredDelta: number,
): Promise<void> {
  const current = await getBucket(store, status);
  await putBucket(store, status, {
    count: current.count + countDelta,
    bytes: current.bytes + bytesDelta,
    bytesTransferred: current.bytesTransferred + bytesTransferredDelta,
  });
}

/**
 * Sum two bucket snapshots into a "total" bucket.
 */
export function sumBuckets(...buckets: BucketStats[]): BucketStats {
  let count = 0;
  let bytes = 0;
  let bytesTransferred = 0;
  for (const b of buckets) {
    count += b.count;
    bytes += b.bytes;
    bytesTransferred += b.bytesTransferred;
  }
  return { count, bytes, bytesTransferred };
}

export async function readAllBuckets(
  store: IDBObjectStore,
): Promise<Record<Status, BucketStats>> {
  const out = {} as Record<Status, BucketStats>;
  for (const s of STATUSES) {
    out[s] = await getBucket(store, s);
  }
  return out;
}
