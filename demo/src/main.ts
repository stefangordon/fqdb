import {
  FileQueue,
  type NewItem,
  type PageCursor,
  type SortDirection,
  type SortField,
  type Status,
  type Stats,
} from 'fqdb';

const QUEUE_NAME = 'demo-downloads';
const PAGE_SIZE_DEFAULT = 50;

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`Missing element: ${sel}`);
  return el;
};

const els = {
  roleBadge: $<HTMLSpanElement>('#role-badge'),
  queueName: $<HTMLSpanElement>('#queue-name'),
  roleHint: $<HTMLSpanElement>('#role-hint'),
  statsGrid: $<HTMLDivElement>('#stats-grid'),
  refreshStats: $<HTMLButtonElement>('#refresh-stats'),
  generateButtons: $<HTMLDivElement>('#generate-buttons'),
  customCount: $<HTMLInputElement>('#custom-count'),
  customAdd: $<HTMLButtonElement>('#custom-add'),
  generateProgress: $<HTMLDivElement>('#generate-progress'),
  claim1: $<HTMLButtonElement>('#claim-1'),
  claim10: $<HTMLButtonElement>('#claim-10'),
  advanceProgress: $<HTMLButtonElement>('#advance-progress'),
  completeAllStarted: $<HTMLButtonElement>('#complete-all-started'),
  failAllStarted: $<HTMLButtonElement>('#fail-all-started'),
  autoToggle: $<HTMLButtonElement>('#auto-toggle'),
  clearCompleted: $<HTMLButtonElement>('#clear-completed'),
  clearFailed: $<HTMLButtonElement>('#clear-failed'),
  clearCancelled: $<HTMLButtonElement>('#clear-cancelled'),
  clearAll: $<HTMLButtonElement>('#clear-all'),
  filterStatus: $<HTMLSelectElement>('#filter-status'),
  sortField: $<HTMLSelectElement>('#sort-field'),
  sortDirection: $<HTMLSelectElement>('#sort-direction'),
  pageSize: $<HTMLSelectElement>('#page-size'),
  itemsTbody: $<HTMLTableSectionElement>('#items-table tbody'),
  pageFirst: $<HTMLButtonElement>('#page-first'),
  pagePrev: $<HTMLButtonElement>('#page-prev'),
  pageLabel: $<HTMLSpanElement>('#page-label'),
  pageNext: $<HTMLButtonElement>('#page-next'),
};

let queue: FileQueue;
let pageHistory: (PageCursor | undefined)[] = [undefined];
let pageIdx = 0;
let autoTimer: ReturnType<typeof setInterval> | null = null;

const fmt = new Intl.NumberFormat('en-US');
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}

function setRole(role: 'writer' | 'reader' | 'error', hint = ''): void {
  els.roleBadge.textContent = role;
  els.roleBadge.className = `role ${role}`;
  els.roleHint.textContent = hint;
  document.body.classList.toggle('is-reader', role !== 'writer');
}

function makeFakeItems(count: number): NewItem[] {
  const folders = [
    'projects',
    'media',
    'archive',
    'downloads',
    'photos',
    'docs',
    'render',
    'logs',
  ];
  const exts = ['mp4', 'zip', 'iso', 'tar.gz', 'jpg', 'mov', 'pdf', 'bin'];
  const offset = Date.now() % 1_000_000;
  const items: NewItem[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const folder = folders[(i * 31 + offset) % folders.length];
    const ext = exts[(i * 17 + offset) % exts.length];
    const sizeBytes =
      Math.floor(Math.pow(2, 12 + ((i * 7) % 22))) +
      ((i * 1024 * 17) % (1024 * 1024));
    items[i] = {
      fileKey: `/${folder}/file_${(offset + i).toString(36)}_${i.toString().padStart(7, '0')}.${ext}`,
      sizeBytes,
    };
  }
  return items;
}

async function generate(count: number): Promise<void> {
  if (count <= 0) return;
  const chunkSize = Math.min(5000, count);
  const totalChunks = Math.ceil(count / chunkSize);
  const fill = els.generateProgress.querySelector<HTMLDivElement>(
    '.progress-fill',
  )!;
  const label = els.generateProgress.querySelector<HTMLSpanElement>(
    '.progress-label',
  )!;
  els.generateProgress.hidden = false;
  fill.style.width = '0%';
  label.textContent = `0 / ${fmt.format(count)}`;

  const t0 = performance.now();
  let added = 0;
  for (let c = 0; c < totalChunks; c++) {
    const n = Math.min(chunkSize, count - c * chunkSize);
    const batch = makeFakeItems(n);
    const result = await queue.enqueue(batch, { chunkSize: 5000 });
    added += result.added;
    const pct = (added / count) * 100;
    fill.style.width = `${pct}%`;
    const elapsed = (performance.now() - t0) / 1000;
    const rate = added / elapsed;
    label.textContent = `${fmt.format(added)} / ${fmt.format(count)} — ${fmt.format(Math.round(rate))} items/s`;
    await new Promise((r) => setTimeout(r, 0));
  }

  setTimeout(() => {
    els.generateProgress.hidden = true;
  }, 800);

  await refreshAll();
}

async function refreshStats(): Promise<void> {
  let stats: Stats;
  try {
    stats = await queue.stats();
  } catch (err) {
    console.error(err);
    return;
  }
  const buckets: { key: keyof Stats; label: string }[] = [
    { key: 'total', label: 'Total' },
    { key: 'pending', label: 'Pending' },
    { key: 'started', label: 'Started' },
    { key: 'completed', label: 'Completed' },
    { key: 'failed', label: 'Failed' },
    { key: 'cancelled', label: 'Cancelled' },
  ];
  els.statsGrid.innerHTML = '';
  for (const { key, label } of buckets) {
    const b = stats[key];
    const card = document.createElement('div');
    card.className = `stat-card ${key}`;
    const sub =
      key === 'started'
        ? `${fmtBytes(b.bytes)} · ${fmtBytes(b.bytesTransferred)} done`
        : fmtBytes(b.bytes);
    card.innerHTML = `
      <div class="label">${label}</div>
      <div class="value">${fmt.format(b.count)}</div>
      <div class="sub">${sub}</div>
    `;
    els.statsGrid.appendChild(card);
  }
}

async function refreshTable(): Promise<void> {
  const status = (els.filterStatus.value || undefined) as Status | undefined;
  const sortBy = els.sortField.value as SortField;
  const direction = els.sortDirection.value as SortDirection;
  const limit = parseInt(els.pageSize.value, 10) || PAGE_SIZE_DEFAULT;

  const opts =
    status === undefined
      ? { sortBy, direction, limit, cursor: pageHistory[pageIdx] }
      : { status, sortBy, direction, limit, cursor: pageHistory[pageIdx] };

  const page = await queue.page(opts);

  els.itemsTbody.innerHTML = '';
  if (page.items.length === 0) {
    els.itemsTbody.innerHTML = `
      <tr><td colspan="7" style="padding: 24px; text-align: center; color: var(--fg-muted)">
        No items.
      </td></tr>`;
  } else {
    for (const item of page.items) {
      const tr = document.createElement('tr');
      const errCell = item.error ? escapeHtml(item.error) : '';
      tr.innerHTML = `
        <td>${item.id}</td>
        <td>${escapeHtml(item.fileKey)}</td>
        <td class="status-${item.status}">${item.status}</td>
        <td>${fmtBytes(item.sizeBytes)}</td>
        <td>${fmtBytes(item.bytesTransferred)}</td>
        <td>${item.attempts}</td>
        <td>${errCell}</td>
      `;
      els.itemsTbody.appendChild(tr);
    }
  }

  els.pageLabel.textContent = `page ${pageIdx + 1}`;
  els.pagePrev.disabled = pageIdx === 0;
  els.pageFirst.disabled = pageIdx === 0;
  els.pageNext.disabled = !page.hasMore;

  if (page.hasMore && page.nextCursor && pageIdx === pageHistory.length - 1) {
    pageHistory.push(page.nextCursor);
  }
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[c]!,
  );
}

async function refreshAll(): Promise<void> {
  await Promise.all([refreshStats(), refreshTable()]);
}

async function init(): Promise<void> {
  els.queueName.textContent = `queue: ${QUEUE_NAME}`;
  try {
    queue = await FileQueue.open(QUEUE_NAME);
  } catch (err) {
    setRole('error', String(err));
    throw err;
  }

  setRole(
    queue.isWriter ? 'writer' : 'reader',
    queue.isWriter
      ? 'This tab owns the queue. Reader tabs see live data but can\u2019t mutate.'
      : 'Another tab owns the queue. This tab is read-only — refresh to retry.',
  );

  els.generateButtons.querySelectorAll<HTMLButtonElement>('button').forEach(
    (btn) => {
      btn.dataset.writerOnly = '';
      btn.addEventListener('click', () => {
        const n = parseInt(btn.dataset.count!, 10);
        void generate(n);
      });
    },
  );
  els.customAdd.dataset.writerOnly = '';
  els.customAdd.addEventListener('click', () => {
    const n = parseInt(els.customCount.value, 10);
    if (Number.isFinite(n) && n > 0) void generate(n);
  });

  for (const btn of [
    els.claim1,
    els.claim10,
    els.advanceProgress,
    els.completeAllStarted,
    els.failAllStarted,
    els.autoToggle,
    els.clearCompleted,
    els.clearFailed,
    els.clearCancelled,
    els.clearAll,
  ]) {
    btn.dataset.writerOnly = '';
  }

  els.claim1.addEventListener('click', async () => {
    await queue.claimNext(1);
    await refreshAll();
  });
  els.claim10.addEventListener('click', async () => {
    await queue.claimNext(10);
    await refreshAll();
  });
  els.advanceProgress.addEventListener('click', async () => {
    await advanceAllStartedProgress();
    await refreshAll();
  });
  els.completeAllStarted.addEventListener('click', async () => {
    await processAllStarted('complete');
    await refreshAll();
  });
  els.failAllStarted.addEventListener('click', async () => {
    await processAllStarted('fail');
    await refreshAll();
  });
  els.autoToggle.addEventListener('click', () => {
    if (autoTimer) {
      clearInterval(autoTimer);
      autoTimer = null;
      els.autoToggle.textContent = 'Auto-process: off';
      return;
    }
    autoTimer = setInterval(() => {
      void autoStep();
    }, 400);
    els.autoToggle.textContent = 'Auto-process: on';
  });

  els.clearCompleted.addEventListener('click', async () => {
    await queue.clear('completed');
    pageHistory = [undefined];
    pageIdx = 0;
    await refreshAll();
  });
  els.clearFailed.addEventListener('click', async () => {
    await queue.clear('failed');
    pageHistory = [undefined];
    pageIdx = 0;
    await refreshAll();
  });
  els.clearCancelled.addEventListener('click', async () => {
    await queue.clear('cancelled');
    pageHistory = [undefined];
    pageIdx = 0;
    await refreshAll();
  });
  els.clearAll.addEventListener('click', async () => {
    if (!confirm('Delete all items in this queue?')) return;
    await queue.clear();
    pageHistory = [undefined];
    pageIdx = 0;
    await refreshAll();
  });

  els.refreshStats.addEventListener('click', () => void refreshAll());

  for (const sel of [
    els.filterStatus,
    els.sortField,
    els.sortDirection,
    els.pageSize,
  ]) {
    sel.addEventListener('change', () => {
      pageHistory = [undefined];
      pageIdx = 0;
      void refreshTable();
    });
  }

  els.pageFirst.addEventListener('click', () => {
    pageHistory = [undefined];
    pageIdx = 0;
    void refreshTable();
  });
  els.pagePrev.addEventListener('click', () => {
    if (pageIdx > 0) pageIdx -= 1;
    void refreshTable();
  });
  els.pageNext.addEventListener('click', () => {
    if (pageIdx < pageHistory.length - 1) {
      pageIdx += 1;
      void refreshTable();
    }
  });

  await refreshAll();
}

async function advanceAllStartedProgress(): Promise<void> {
  if (!queue.isWriter) return;
  await queue.iterate({ status: 'started', batchSize: 100 }, async (batch) => {
    for (const item of batch) {
      const next = Math.min(
        item.sizeBytes,
        item.bytesTransferred + Math.floor(item.sizeBytes / 4) + 1,
      );
      await queue.updateProgress(item.id, next);
    }
  });
}

async function processAllStarted(action: 'complete' | 'fail'): Promise<void> {
  if (!queue.isWriter) return;
  await queue.iterate({ status: 'started', batchSize: 100 }, async (batch) => {
    for (const item of batch) {
      if (action === 'complete') await queue.complete(item.id);
      else await queue.fail(item.id, 'simulated failure');
    }
  });
}

async function autoStep(): Promise<void> {
  if (!queue.isWriter) return;
  const stats = await queue.stats();
  if (stats.started.count > 0) {
    await advanceAllStartedProgress();
    await queue.iterate(
      { status: 'started', batchSize: 100 },
      async (batch) => {
        for (const item of batch) {
          if (item.bytesTransferred >= item.sizeBytes) {
            await queue.complete(item.id);
          }
        }
      },
    );
  }
  if (stats.pending.count > 0 && stats.started.count < 5) {
    await queue.claimNext(Math.min(3, stats.pending.count));
  }
  await refreshAll();
}

void init();
