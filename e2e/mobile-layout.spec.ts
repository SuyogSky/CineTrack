import { test, expect } from '@playwright/test';

test.describe('E2E: Responsive Mobile Experience', () => {
  const timestamp = Date.now();
  const mobileUser = {
    username: `mobile_${timestamp}`,
    email: `mobile_${timestamp}@cinetrack.local`,
    password: 'Password123!',
  };

  test('should render mobile layout and open navigation drawer properly', async ({
    page,
  }) => {
    // Force mobile viewport
    await page.setViewportSize({ width: 390, height: 844 });

    // 1. Visit landing page
    await page.goto('/');
    await expect(page).toHaveTitle(/CineTrack/);

    // Verify no horizontal overflow
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 2);

    // 2. Register fresh mobile user
    await page.goto('/register');
    await page.fill('input[type="text"]', mobileUser.username);
    await page.fill('input[type="email"]', mobileUser.email);
    await page.locator('input[type="password"]').first().fill(mobileUser.password);
    await page.locator('input[type="password"]').nth(1).fill(mobileUser.password);
    await page.click('button:has-text("Create Account")');

    // 3. Verify mobile dashboard
    await expect(page).toHaveURL(/.*\/dashboard/);

    // 4. Test mobile drawer menu
    const hamburger = page.locator('[data-testid="mobile-menu-button"]');
    await expect(hamburger).toBeVisible();
    await hamburger.click();

    // Verify navigation links inside drawer
    const watchlistNavLink = page.locator('[data-testid="mobile-nav-watchlist"]');
    await expect(watchlistNavLink).toBeVisible();

    // Click Watchlist from mobile drawer
    await watchlistNavLink.click();
    await expect(page).toHaveURL(/.*\/watchlist/);
    await expect(page.locator('h1:has-text("My Watchlist")')).toBeVisible();
  });
});
