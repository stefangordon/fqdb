import { expect, test } from '@playwright/test';

/**
 * Cross-tab writer election only behaves correctly in a real browser with the
 * Web Locks API. These tests run against a built copy of the demo app served
 * by `vite preview`, exercise two browser contexts that share IndexedDB
 * storage scope (same origin), and assert single-writer semantics.
 *
 * Note: each browser context in Playwright is isolated (separate origin
 * storage), so we use two pages within the SAME context to share the lock
 * scope. That mirrors what real users see: two tabs of the same site.
 */

const ROLE_WRITER = 'writer';
const ROLE_READER = 'reader';

test.describe('cross-tab writer election', () => {
  test('first tab is writer, second is reader, lock releases on close', async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const tabA = await context.newPage();
    await tabA.goto('/');
    await expect(tabA.locator('#role-badge')).toHaveText(ROLE_WRITER, {
      timeout: 10_000,
    });

    const tabB = await context.newPage();
    await tabB.goto('/');
    await expect(tabB.locator('#role-badge')).toHaveText(ROLE_READER, {
      timeout: 10_000,
    });

    // Reader should not be able to mutate via UI (writerOnly buttons disabled).
    const isReader = await tabB.evaluate(() =>
      document.body.classList.contains('is-reader'),
    );
    expect(isReader).toBe(true);

    // Close the writer tab; reload the reader tab — it should now be writer.
    await tabA.close();
    await tabB.reload();
    await expect(tabB.locator('#role-badge')).toHaveText(ROLE_WRITER, {
      timeout: 10_000,
    });

    await context.close();
  });

  test('writer can enqueue items and reader sees them after refresh', async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const writer = await context.newPage();
    await writer.goto('/');
    await expect(writer.locator('#role-badge')).toHaveText(ROLE_WRITER);

    // Generate 100 items via the demo's UI button.
    await writer.locator('#generate-buttons button[data-count="100"]').click();
    await writer.waitForFunction(
      () =>
        document.querySelector('#stats-grid .stat-card.total .value')
          ?.textContent === '100',
      undefined,
      { timeout: 10_000 },
    );

    const reader = await context.newPage();
    await reader.goto('/');
    await expect(reader.locator('#role-badge')).toHaveText(ROLE_READER);
    const total = await reader
      .locator('#stats-grid .stat-card.total .value')
      .textContent();
    expect(total).toBe('100');

    await context.close();
  });
});
