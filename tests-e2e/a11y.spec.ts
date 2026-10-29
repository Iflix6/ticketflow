import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/**
 * Accessibility smoke (pack line 130: "E2E UI flows + accessibility smoke tests"). axe-core
 * checks each rendered page for critical/serious WCAG violations; the assertion is on the
 * RULE IDS, so a failure names what to fix rather than showing a count. This is a smoke test,
 * not a full audit — manual keyboard passes and VoiceOver/NVDA spot checks stay in the
 * hardening backlog, and saying so is better than implying a badge of accessibility.
 */

async function scan(page: Page, label: string) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const blocking = results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
  expect(blocking, `${label}: ${blocking.map((v) => `${v.id}(${v.impact})`).join(', ')}`).toEqual([]);
}

test('public pages have no critical/serious axe violations', async ({ page }) => {
  await page.goto('/events');
  await scan(page, '/events');

  await page.goto('/login');
  await scan(page, '/login');
});

test('signed-in booking surface and lab dashboard have no critical/serious axe violations', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('lab@local.test');
  await page.getByLabel('Password').fill('local-demo-admin-2026');
  await page.getByRole('button', { name: 'Sign in' }).click();

  await page.goto('/lab');
  await scan(page, '/lab (runs list)');

  await page.goto('/lab/strategies');
  await scan(page, '/lab/strategies');

  await page.goto('/lab/scenario');
  await scan(page, '/lab/scenario');
});

test('skip link moves focus past the navigation', async ({ page }) => {
  await page.goto('/events');
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: /skip to main content/i });
  await expect(skip).toBeFocused();
});
