/**
 * IndexedDB schema and promise-based helpers.
 *
 * Two object stores per queue database:
 *   - `items`     : the actual queue items, keyPath `id`, autoIncrement.
 *   - `aggregates`: O(1) per-status counters, out-of-line keyed by status string.
 *
 * Indexes on `items`:
 *   - by_status_id    : [status, id]        (FIFO claim, default sort within status)
 *   - by_status_size  : [status, sizeBytes] (size sort within a status)
 *   - by_status_key   : [status, fileKey]   (alphabetical sort within a status)
 *   - by_fileKey      : fileKey             (dedup + global alphabetical sort)
 *   - by_sizeBytes    : sizeBytes           (global size sort)
 */

export const ITEMS = 'items';
export const AGGREGATES = 'aggregates';

export const IDX_STATUS_ID = 'by_status_id';
export const IDX_STATUS_SIZE = 'by_status_size';
export const IDX_STATUS_KEY = 'by_status_key';
export const IDX_FILEKEY = 'by_fileKey';
export const IDX_SIZE = 'by_sizeBytes';

export const DB_PREFIX = 'fqdb:';
export const DB_VERSION = 2;

export function dbName(queueName: string): string {
  return `${DB_PREFIX}${queueName}`;
}

export function lockName(queueName: string): string {
  return `${DB_PREFIX}${queueName}:writer`;
}

export function openDb(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, DB_VERSION);
    req.onerror = (): void => reject(req.error);
    req.onblocked = (): void =>
      reject(new Error(`Database ${name} is blocked by another connection`));
    req.onupgradeneeded = (event): void => {
      const db = req.result;
      const upgradeTx = req.transaction;
      const oldVersion = event.oldVersion;

      if (oldVersion < 1) {
        const items = db.createObjectStore(ITEMS, {
          keyPath: 'id',
          autoIncrement: true,
        });
        items.createIndex(IDX_STATUS_ID, ['status', 'id']);
        items.createIndex(IDX_STATUS_SIZE, ['status', 'sizeBytes']);
        items.createIndex(IDX_STATUS_KEY, ['status', 'fileKey']);
        items.createIndex(IDX_FILEKEY, 'fileKey', { unique: false });
        db.createObjectStore(AGGREGATES);
      }

      if (oldVersion < 2 && upgradeTx) {
        const items = upgradeTx.objectStore(ITEMS);
        if (!items.indexNames.contains(IDX_SIZE)) {
          items.createIndex(IDX_SIZE, 'sizeBytes', { unique: false });
        }
      }
    };
    req.onsuccess = (): void => resolve(req.result);
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
