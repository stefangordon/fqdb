export type Status =
  | 'pending'
  | 'started'
  | 'completed'
  | 'failed'
  | 'cancelled';

export const STATUSES: readonly Status[] = [
  'pending',
  'started',
  'completed',
  'failed',
  'cancelled',
] as const;

export interface NewItem {
  fileKey: string;
  sizeBytes?: number;
  meta?: Record<string, unknown>;
}

export interface QueueItem {
  id: number;
  fileKey: string;
  status: Status;
  sizeBytes: number;
  bytesTransferred: number;
  attempts: number;
  error?: string;
  meta?: Record<string, unknown>;
}

export interface BucketStats {
  count: number;
  bytes: number;
  bytesTransferred: number;
}

export interface Stats {
  pending: BucketStats;
  started: BucketStats;
  completed: BucketStats;
  failed: BucketStats;
  cancelled: BucketStats;
  total: BucketStats;
}

export type SortField = 'id' | 'sizeBytes' | 'fileKey';
export type SortDirection = 'asc' | 'desc';

export interface PageCursor {
  indexKey: IDBValidKey;
  primaryKey: number;
}

export interface PageOptions {
  status?: Status;
  sortBy?: SortField;
  direction?: SortDirection;
  cursor?: PageCursor;
  limit?: number;
}

export interface PageResult {
  items: QueueItem[];
  nextCursor?: PageCursor;
  hasMore: boolean;
}

export interface IterateOptions {
  status?: Status;
  batchSize?: number;
}

export interface EnqueueOptions {
  /**
   * If true, items whose fileKey already exists in the queue are silently skipped.
   * Default: false (duplicates allowed; useful for retry semantics).
   */
  skipDuplicates?: boolean;
  /**
   * Maximum items per IDB transaction. Larger values are faster but use more memory
   * and may hit transaction time limits in some browsers. Default: 5000.
   */
  chunkSize?: number;
}

export interface EnqueueResult {
  added: number;
  skipped: number;
  ids: number[];
}

export interface OpenOptions {
  /**
   * If another tab already owns the writer lock, throw QueueLockedError instead
   * of opening as a read-only reader. Default: false.
   */
  requireWriter?: boolean;
  /**
   * Skip the navigator.storage.persist() call at startup. Default: false.
   */
  skipPersist?: boolean;
  /**
   * Skip reverting any leftover `started` items to `pending` (with attempts++)
   * when this tab becomes the writer. Default: false.
   */
  skipRecovery?: boolean;
}
