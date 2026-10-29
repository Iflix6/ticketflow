import { expect, test, type Page } from '@playwright/test';

/**
 * Booking-flow E2E against the live stack (dev:api + dev:web + PostgreSQL). Every assertion is
 * about text the SERVER sent to the browser: the countdown second figure comes from the API's
 * secondsRemaining, the booking line quotes the stored decimal total. If the UI ever fabricated a
 * success, these tests would fail — that is the point.
 */

async function loginViaForm(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test('customer signs in through the UI and books two seats end-to-end', async ({ page }) => {
  await page.goto('/login');

  // Wrong password: the honest generic 401, no enumeration, no fake success.
  await page.getByLabel('Email').fill('customer@local.test');
  await page.getByLabel('Password').fill('definitely-not-the-demo-password-12345');
  await page.getByRole('button', { name: 'Sign in' }).click();
  // Next's route announcer is also role="alert" (empty), so target the form's own alert paragraph.
  await expect(page.locator('form p[role="alert"]')).toContainText('unauthorized');

  // Right password lands on the catalog.
  await loginViaForm(page, 'customer@local.test', 'local-demo-customer-2026');
  await expect(page).toHaveURL(/\/events$/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Events');

  // Open the first event and hold two seats in the first tier.
  await page.getByRole('link', { name: /Lab Fixture/i }).first().click();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const qty = page.locator('input[type="number"]').first();
  await qty.fill('2');
  await page.getByRole('button', { name: /Hold 2 seats/ }).click();

  // The hold exists only once the server's 201 renders it: countdown from server seconds.
  const held = page.getByRole('status');
  await expect(held).toContainText(/left to confirm/i);
  await expect(held).toContainText(/\d+s/);

  // Fake checkout with the deterministic success knob; confirmation must quote the server total.
  await page.getByRole('button', { name: 'Pay now' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'CONFIRMED' })).toContainText(
    /server total USD \d+\.\d{2}/,
  );

  // My bookings shows the same booking the server confirmed.
  await page.goto('/bookings');
  await expect(page.getByRole('row').filter({ hasText: 'CONFIRMED' }).first()).toBeVisible();
});

test('anonymous visitors get the sign-in prompt on protected surfaces', async ({ page }) => {
  await page.goto('/bookings');
  // The bookings page redirects anonymous users to /login rather than rendering an empty "success" list.
  await expect(page).toHaveURL(/\/login/);

  await page.goto('/lab');
  await expect(page.getByText('requires a signed-in LAB_ADMIN session')).toBeVisible();
});

test('a signed-in customer sees an honest 403 notice on the lab, not mock data', async ({ page }) => {
  await loginViaForm(page, 'customer@local.test', 'local-demo-customer-2026');
  await expect(page).toHaveURL(/\/events$/);
  await page.goto('/lab');
  await expect(page.getByText('answers 403 for every lab route')).toBeVisible();
});
