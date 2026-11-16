import { test, expect } from '@playwright/test';

test.describe('E2E: Authentication & Watchlist Workflows', () => {
  const timestamp = Date.now();
  const testUser = {
    username: `viewer_${timestamp}`,
    email: `viewer_${timestamp}@cinetrack.local`,
    password: 'Password123!',
  };

  test('should register, search TMDb, add movie to watchlist, and toggle watch status', async ({
    page,
  }) => {
    // 1. Visit landing page
    await page.goto('/');
    await expect(page).toHaveTitle(/CineTrack/);

    // 2. Click Get Started / Register
    await page.goto('/register');
    await expect(page).toHaveURL(/.*\/register/);

    // 3. Fill registration form
    await page.fill('input[type="text"]', testUser.username);
    await page.fill('input[type="email"]', testUser.email);
    await page.locator('input[type="password"]').first().fill(testUser.password);
    await page.locator('input[type="password"]').nth(1).fill(testUser.password);
    await page.click('button:has-text("Create Account")');

    // 4. Redirects to dashboard
    await expect(page).toHaveURL(/.*\/dashboard/);
    await expect(page.locator(`text=Welcome back, ${testUser.username}!`)).toBeVisible();

    // 5. Navigate to Watchlist
    await page.click('a:has-text("Watchlist")');
    await expect(page).toHaveURL(/.*\/watchlist/);
    await expect(page.locator('h1:has-text("My Watchlist")')).toBeVisible();

    // 6. Open Search Modal
    await page.click('button:has-text("Add Movies")');
    await expect(page.locator('h3:has-text("Search & Add Movies")')).toBeVisible();

    // 7. Search for a movie
    const searchInput = page.locator('input[placeholder*="Search by title"]');
    await searchInput.fill('Inception');

    // Wait for search result item and click Add using data-testid
    const addButton = page.locator('[data-testid="modal-add-button"]').first();
    await expect(addButton).toBeVisible({ timeout: 10000 });
    await addButton.click();
    await expect(page.locator('button:has-text("Added")').first()).toBeVisible();

    // Close modal
    await page.keyboard.press('Escape');

    // 8. Verify movie appears in "To Watch" section
    await expect(page.locator('h4:has-text("Inception")').first()).toBeVisible();
    await expect(page.locator('text=To Watch (1)').first()).toBeVisible();

    // 9. Mark movie as Watched
    const markWatchedBtn = page.locator('button:has-text("Mark Watched")').first();
    await markWatchedBtn.click();

    // 10. Verify movie moved to Watched section
    await expect(page.locator('h3:has-text("Watched Movies (1)")')).toBeVisible();
    await expect(page.locator('button:has-text("Mark Unwatched")').first()).toBeVisible();

    // 11. Test reload persistence
    await page.reload();
    await expect(page.locator('h3:has-text("Watched Movies (1)")')).toBeVisible();
    await expect(page.locator('h4:has-text("Inception")').first()).toBeVisible();
  });
});
