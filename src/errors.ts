export class FqdbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FqdbError';
  }
}

/**
 * Thrown when a writer-only operation is attempted on a reader (read-only) queue,
 * or when `requireWriter: true` was passed to `open()` and another tab already
 * holds the writer lock.
 */
export class QueueLockedError extends FqdbError {
  constructor(message = 'Queue is owned by another tab; this tab is read-only.') {
    super(message);
    this.name = 'QueueLockedError';
  }
}

/**
 * Thrown when an item id is not found in the queue.
 */
export class ItemNotFoundError extends FqdbError {
  constructor(public readonly id: number) {
    super(`Item ${id} not found`);
    this.name = 'ItemNotFoundError';
  }
}

/**
 * Thrown when an operation is attempted on a closed queue.
 */
export class QueueClosedError extends FqdbError {
  constructor() {
    super('Queue has been closed');
    this.name = 'QueueClosedError';
  }
}
