import { expect, test, type Page } from '@playwright/test';

/**
 * Lab E2E: launch a REAL small experiment through the scenario builder and watch the dashboard
 * render the server's aggregates. This test creates database facts; it is why the Playwright
 * config runs a single worker. Numbers are asserted as "the server's", not as fixed expectations —
 * the run is live, so the test checks structure (attempted == succeeded + soldOut on a safe
 * strategy, a present results table) rather than a specific timing outcome it cannot control.
 */

async function loginAsAdmin(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill('lab@local.test');
  await page.getByLabel('Password').fill('local-demo-admin-2026');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/events$/);
}

test('admin launches an atomic_update run from the scenario builder and lands on its real results', async ({ page }) => {
  await loginAsAdmin(page);

  await page.goto('/lab/scenario');
  await page.getByLabel('Allocation strategy').selectOption('atomic_update');
  await page.getByLabel('Ticket capacity').fill('8');
  await page.getByLabel('Concurrent buyers').fill('20');
  await page.getByLabel('Seats per buyer').fill('1');
  await page.getByLabel('Label (optional, ≤120 chars)').fill('e2e playwright run');
  await page.getByRole('button', { name: 'Launch run' }).click();

  // Synchronous endpoint: navigation happens only when the completed run arrives.
  await expect(page).toHaveURL(/\/lab\/runs\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { name: 'Outcomes (server-aggregated)' })).toBeVisible();

  // Structural truth for a safe strategy under capacity pressure: every attempt is accounted for.
  const outcomeText = await page.locator('section:has-text("Outcomes") dl').first().innerText();
  const num = (label: string): number => {
    const m = outcomeText.match(new RegExp(`${label}\\s+([\\d,.]+)`));
    if (m === null || m[1] === undefined) throw new Error(`outcome ${label} not found in rendered text`);
    return Number(m[1].replace(/,/g, ''));
  };
  const attempted = num('Attempted');
  const succeeded = num('Succeeded');
  const soldOut = num('Sold out');
  expect(attempted).toBe(20);
  expect(succeeded + soldOut).toBe(20);
  expect(succeeded).toBe(8); // capacity is the ceiling — the invariant the whole project exists to defend

  // Results table shows one row per attempt (subject to the documented 5,000 cap).
  await expect(page.getByRole('status').filter({ hasText: /rows shown/ })).toContainText('20 of 20');

  // The run is listed on the dashboard under its strategy.
  await page.goto('/lab');
  await expect(page.getByRole('row').filter({ hasText: 'atomic_update' }).first()).toBeVisible();
});

test('CSV export serves the run rows from the web route handler', async ({ page }) => {
  await loginAsAdmin(page);
  // Newest run id via the documented list endpoint, fetched IN-PAGE so the session cookie rides along.
  const json = await page.evaluate(async () => {
    const r = await fetch('/api/v1/lab/runs?page=1&pageSize=1');
    if (!r.ok) throw new Error(`list failed ${r.status}`);
    return r.json() as Promise<{ data: { id: string }[] }>;
  });
  const runId = json.data[0]?.id;
  if (runId === undefined) throw new Error('no runs listed — the previous test should have created one');

  const csv = await page.evaluate(async (id) => {
    const r = await fetch(`/lab/runs/${id}/export`);
    return { status: r.status, text: r.status === 200 ? await r.text() : '' };
  }, runId);
  expect(csv.status).toBe(200);
  const lines = csv.text.trim().split(/\r?\n/);
  expect(lines[0]).toContain('requestIndex');
  expect(lines.length).toBeGreaterThan(1);
});
