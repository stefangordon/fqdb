/**
 * Web Locks API wrapper for cross-tab single-writer election.
 *
 * The first tab to call acquireWriterLock() wins the exclusive lock and
 * receives `{ isWriter: true, release }`. Subsequent tabs receive
 * `{ isWriter: false, release: noop }` immediately because we use
 * `ifAvailable: true`.
 *
 * The lock is held for the lifetime of the tab (until `release()` is called
 * or the page unloads — the browser auto-releases on navigation/crash).
 */

export interface LockHandle {
  readonly isWriter: boolean;
  release(): void;
}

const NOOP = (): void => {};

function hasWebLocks(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.locks !== 'undefined' &&
    typeof navigator.locks.request === 'function'
  );
}

export async function acquireWriterLock(name: string): Promise<LockHandle> {
  if (!hasWebLocks()) {
    return { isWriter: true, release: NOOP };
  }

  return new Promise<LockHandle>((resolveHandle, rejectHandle) => {
    let releaseHolder: () => void = NOOP;

    navigator.locks
      .request(
        name,
        { mode: 'exclusive', ifAvailable: true },
        (lock) => {
          if (lock === null) {
            resolveHandle({ isWriter: false, release: NOOP });
            return undefined;
          }
          return new Promise<void>((resolveHolder) => {
            releaseHolder = resolveHolder;
            resolveHandle({
              isWriter: true,
              release: () => releaseHolder(),
            });
          });
        },
      )
      .catch((err: unknown) => {
        rejectHandle(err);
      });
  });
}

/**
 * Convenience: query whether any tab currently holds the named lock.
 * Useful for read-only tabs to detect when a writer disappears so they can
 * offer the user a "Take over" button (which would call acquireWriterLock again).
 */
export async function isLockHeld(name: string): Promise<boolean> {
  if (!hasWebLocks() || typeof navigator.locks.query !== 'function') {
    return false;
  }
  const snapshot = await navigator.locks.query();
  const held = snapshot.held ?? [];
  return held.some((entry) => entry.name === name);
}
