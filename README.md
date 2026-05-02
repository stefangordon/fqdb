# fqdb

Persistent, indexed file queue for the browser. **IndexedDB** for storage,
**Web Locks** for cross-tab single-writer election, **O(1) stats**.

Built for client-side file managers that may queue millions of operations and
need to survive page reloads, crashes, and multiple open tabs.

- **Survives crashes & reloads.** Items live in IndexedDB, not in memory.
- **Single-writer across tabs.** First tab to open the queue gets exclusive
  write access via the Web Locks API; other tabs are read-only and can detect
  it. Lock auto-releases when the writer tab closes.
- **Scales to 10M+ items.** Keyset pagination, indexed status filters, O(1)
  count and byte-total stats backed by a transactional aggregate store.
- **File-aware.** First-class `sizeBytes` and `bytesTransferred` fields with
  built-in totals per status (`bytes - bytesTransferred = remaining`).
- **Zero runtime dependencies.** ~24 KB ESM. Works in any framework that runs
  in a browser (React, Vue, Svelte, Deno Fresh, vanilla — it's just TypeScript).

[**→ Live demo**](https://stefangordon.github.io/fqdb/) (open it in two tabs to
see writer/reader election in action.)

## Install

```bash
npm install fqdb
```

## Quickstart

```typescript
import { FileQueue, QueueLockedError } from 'fqdb';

const queue = await FileQueue.open('downloads');

if (queue.isWriter) {
  await queue.enqueue([
    { fileKey: '/projects/render.mov', sizeBytes: 1_200_000_000 },
    { fileKey: '/projects/audio.wav', sizeBytes:    80_000_000 },
  ]);

  const [item] = await queue.claimNext(1);
  if (item) {
    // ... transfer the file, calling queue.updateProgress(item.id, bytes) periodically
    await queue.updateProgress(item.id, 600_000_000);
    await queue.complete(item.id);
  }
}

const stats = await queue.stats();
console.log(`${stats.pending.count} pending, ${stats.completed.count} done`);
console.log(`${stats.started.bytes - stats.started.bytesTransferred} bytes still to go`);
```

If another tab already owns the queue, your tab will be a reader. Calling any
mutation method on a reader throws `QueueLockedError`. You can still read
counts, stats, and pages.

```typescript
if (!queue.isWriter) {
  showBanner('Another tab is the active queue. This tab is read-only.');
}
```

## API

### `FileQueue.open(name, opts?)` → `Promise<FileQueue>`

Open or create a queue. The first tab to call `open(name)` becomes the writer
across the whole origin; subsequent tabs are readers.

```typescript
interface OpenOptions {
  /** Throw QueueLockedError instead of becoming a reader. */
  requireWriter?: boolean;
  /** Skip navigator.storage.persist() at startup. */
  skipPersist?: boolean;
  /** Skip reverting leftover `started` items to `pending` (with attempts++)
   *  on writer election. Default: recovery enabled. */
  skipRecovery?: boolean;
}
```

### Item shape

```typescript
type Status =
  | 'pending'    // waiting in the queue
  | 'started'    // claimed by a worker, actively being processed
  | 'completed'  // terminal: success
  | 'failed'     // terminal: error
  | 'cancelled'; // terminal: cancelled by the user

interface QueueItem {
  id: number;
  fileKey: string;       // your identifier (path, URL, S3 key, anything)
  status: Status;
  sizeBytes: number;     // 0 if unknown; required field
  bytesTransferred: number;
  attempts: number;
  error?: string;
  meta?: Record<string, unknown>;  // free-form, not indexed
}
```

### Read-only methods (any tab)

| Method | Notes |
|---|---|
| `count(status?)` | O(1). Total count or per-status count. |
| `stats()` | O(1). Returns per-status `{ count, bytes, bytesTransferred }` plus a `total` rollup. |
| `get(id)` | Single item by id. |
| `has(fileKey)` | Whether any item with this `fileKey` exists. |
| `page(opts)` | Keyset-paginated read. See below. |
| `iterate(opts, onBatch)` | Cursor over every matching item in batches. Use for bulk processing without loading everything in memory. |

### `page(opts)` — keyset pagination

Scales to millions of items because it doesn't use offset.

```typescript
interface PageOptions {
  status?: Status;
  sortBy?: 'id' | 'sizeBytes' | 'fileKey';   // default 'id'
  direction?: 'asc' | 'desc';                 // default 'asc'
  cursor?: PageCursor;
  limit?: number;                             // default 100
}

const first = await queue.page({ status: 'pending', limit: 50 });
// ... render first.items
const second = first.hasMore
  ? await queue.page({ status: 'pending', limit: 50, cursor: first.nextCursor })
  : null;
```

All sort fields work both with and without a `status` filter, ascending or
descending.

### Writer methods

All writer methods throw `QueueLockedError` if called from a reader tab and
`QueueClosedError` if called after `close()`.

| Method | Notes |
|---|---|
| `enqueue(items, opts?)` | Add items. Pass arbitrary array sizes — chunked internally. `skipDuplicates: true` checks the `fileKey` index. Returns `{ added, skipped, ids }`. |
| `claimNext(n?)` | Atomically flip up to N pending items to `started`, FIFO. |
| `updateProgress(id, bytesTransferred)` | Update progress on a `started` item. Aggregates updated atomically. |
| `complete(id)` | `started` → `completed`. Sets `bytesTransferred = sizeBytes`. |
| `fail(id, error, { retry? })` | `started` → `failed`, or back to `pending` (attempts++) if `retry: true`. |
| `cancel(ids)` | Move pending/started items to `cancelled`. Skips terminal-state items. |
| `clear(status?)` | Delete every item in a status (or all items if no status given). |
| `destroy()` | Delete the IndexedDB database for this queue. Closes first. |
| `close()` | Close the connection and release the writer lock. |

### Errors

```typescript
import {
  FqdbError,            // base class
  QueueLockedError,     // writer method called on reader
  QueueClosedError,     // any method called after close()
  ItemNotFoundError,    // unknown id
} from 'fqdb';
```

## How the cross-tab lock works

`FileQueue.open()` calls `navigator.locks.request()` with `mode: 'exclusive'`
and `ifAvailable: true`:

- If **no other tab** holds the lock, this tab gets it and becomes the writer.
- If **another tab** holds it, the request returns `null` immediately and this
  tab becomes a reader.

The lock is held for the lifetime of the writer tab. The browser **automatically
releases it** when the tab closes, navigates away, or crashes — so a stuck
writer is impossible. Reader tabs can call `isQueueLocked(name)` or simply
reload the page to retry election.

On startup, when a tab becomes the writer, fqdb reverts any leftover `started`
items to `pending` and bumps their `attempts` counter (assuming the previous
writer crashed mid-transfer). The item's `bytesTransferred` is left intact, so
workers that support resumable transfers can use it as a resume offset.
Disable with `{ skipRecovery: true }`.

```typescript
import { isQueueLocked } from 'fqdb';

if (await isQueueLocked('downloads')) {
  // Another tab is the writer. Wait for it to close, or open as a reader.
}
```

## Performance notes

- **`enqueue` is throughput-optimized.** Issues all IDB add requests up front
  on a single transaction, then awaits the results. Pass `chunkSize` to
  control transaction size (default 5,000).
- **`stats()` and `count()` are O(1).** Backed by an aggregate object store
  updated transactionally with every mutation.
- **`page()` uses keyset paging** via `IDBCursor.continuePrimaryKey`, so
  navigating to "page 50,000" is the same speed as navigating to page 2.
- **Indexes** (5): `[status, id]`, `[status, sizeBytes]`, `[status, fileKey]`,
  `fileKey`, and `sizeBytes`. Status-filtered sorts use the compound indexes;
  global sorts use the single-field ones. The difference between a
  millisecond filter and a full table scan at 10M rows.

For huge enqueue operations from a UI worker, consider running fqdb inside a
**Web Worker** so the main thread isn't briefly stalled by transaction
processing. fqdb is stateless across calls and works fine inside workers.

## Browser support

- Chrome / Edge: all modern versions.
- Firefox: all modern versions.
- Safari: 15.4+ (March 2022). Earlier Safaris lack the Web Locks API and
  would need a polyfill.

`indexedDB`, `IDBCursor.continuePrimaryKey`, and `navigator.locks` are all
required.

## Storage durability

fqdb calls `navigator.storage.persist()` at startup so the browser is asked
not to evict your queue under storage pressure. The user may need to grant
permission depending on browser/profile state. Disable with `{ skipPersist: true }`.

Use `navigator.storage.estimate()` from your app to surface quota information
to the user before huge enqueues.

## Development

```bash
npm install
npm test               # vitest unit tests with fake-indexeddb
npm run typecheck
npm run build          # builds dist/
npm run demo           # vite dev server for the demo at demo/
npm run demo:build     # static build of the demo
npm run test:e2e       # playwright cross-tab tests in real Chromium
```

## License

MIT © Stefan Gordon
