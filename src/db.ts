/**
 * IndexedDB schema and promise-based helpers.
 *
 * Two object stores per queue database:
 *   - `items`     : the actual queue items, keyPath `id`, autoIncrement.
 *   - `aggregates`: O(1) per-status counters, out-of-line keyed by status string.
 *
 * Indexes on `items`:
 *   - by_status_id    : [status, id]        (FIFO claim, default sort)
 *   - by_status_size  : [status, sizeBytes] (size sort within a status)
 *   - by_status_key   : [status, fileKey]   (alphabetical sort within a status)
 *   - by_fileKey      : fileKey             (dedup lookup, non-unique)
 */

export const ITEMS = 'items';
export const AGGREGATES = 'aggregates';

export const IDX_STATUS_ID = 'by_status_id';
export const IDX_STATUS_SIZE = 'by_status_size';
export const IDX_STATUS_KEY = 'by_status_key';
export const IDX_FILEKEY = 'by_fileKey';

export const DB_PREFIX = 'fqdb:';

export function dbName(queueName: string): string {
  return `${DB_PREFIX}${queueName}`;
}

export function lockName(queueName: string): string {
  return `${DB_PREFIX}${queueName}:writer`;
}

export function openDb(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onerror = () => reject(req.error);
    req.onblocked = () =>
      reject(new Error(`Database ${name} is blocked by another connection`));
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(ITEMS)) {
        const items = db.createObjectStore(ITEMS, {
          keyPath: 'id',
          autoIncrement: true,
        });
        items.createIndex(IDX_STATUS_ID, ['status', 'id']);
        items.createIndex(IDX_STATUS_SIZE, ['status', 'sizeBytes']);
        items.createIndex(IDX_STATUS_KEY, ['status', 'fileKey']);
        items.createIndex(IDX_FILEKEY, 'fileKey', { unique: false });
      }
      if (!db.objectStoreNames.contains(AGGREGATES)) {
        db.createObjectStore(AGGREGATES);
      }
    };
    req.onsuccess = () => resolve(req.result);
  });
}

export function deleteDb(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name);
    req.onerror = () => reject(req.error);
    req.onblocked = () =>
      reject(new Error(`Cannot delete ${name}: blocked by another connection`));
    req.onsuccess = () => resolve();
  });
}

export function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function txToPromise(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Transaction error'));
    tx.onabort = () => reject(tx.error ?? new Error('Transaction aborted'));
  });
}
