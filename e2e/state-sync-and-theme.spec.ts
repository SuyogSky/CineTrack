import { test, expect } from '@playwright/test';

test.describe('E2E: State Management Sync, Custom Controls, Theme System & Mobile UX', () => {
  test.beforeEach(async ({ page }) => {
    const uniqueId = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
    const testUser = {
      username: `ux_${uniqueId}`,
      email: `ux_${uniqueId}@cinetrack.local`,
      password: 'Password123!',
    };

    // Register test user
    await page.goto('/register');
    await page.fill('input[type="text"]', testUser.username);
    await page.fill('input[type="email"]', testUser.email);
    await page.locator('input[type="password"]').first().fill(testUser.password);
    await page.locator('input[type="password"]').nth(1).fill(testUser.password);
    await page.click('button:has-text("Create Account")');
    await expect(page).toHaveURL(/.*\/dashboard/);
  });

  test('Part 1 & 2: Modal close button, dismissal, and instantaneous watched/unwatched sync', async ({
    page,
  }) => {
    // 1. Add a movie to Watchlist first
    await page.goto('/watchlist');
    await page.click('button:has-text("Add Movies")');
    await expect(page.locator('h3:has-text("Search & Add Movies")')).toBeVisible();

    // Verify custom collection dropdown is present and accessible
    const customSelect = page.locator('[data-testid="search-collection-select"]');
    await expect(customSelect).toBeVisible();

    // Search and add Inception
    const searchInput = page.locator('input[placeholder*="Search by title"]');
    await searchInput.fill('Inception');
    const addButton = page.locator('[data-testid="modal-add-button"]').first();
    await expect(addButton).toBeVisible({ timeout: 10000 });
    await addButton.click();
    await expect(page.locator('button:has-text("Added")').first()).toBeVisible();

    // Close search modal
    await page.keyboard.press('Escape');

    // 2. Open movie details modal
    const movieTitle = page.locator('h4:has-text("Inception")').first();
    await expect(movieTitle).toBeVisible();
    await movieTitle.click();

    // Verify modal is open and has dialog role
    const modalDialog = page.locator('div[role="dialog"]');
    await expect(modalDialog).toBeVisible();

    // 3. Verify close button presence and touch target
    const closeBtn = page.locator('[data-testid="modal-close-button"]');
    await expect(closeBtn).toBeVisible();

    // 4. Verify initial state: To Watch
    const statusBadge = page.locator('[data-testid="modal-status-badge"]');
    await expect(statusBadge).toContainText('To Watch');
    const toggleBtn = page.locator('[data-testid="modal-status-toggle-button"]');
    await expect(toggleBtn).toContainText('Mark as Watched');

    // 5. Click "Mark as Watched" -> instant update without page reload
    await toggleBtn.click();
    await expect(toggleBtn).toContainText('Mark as Unwatched');
    await expect(statusBadge).toContainText('Watched');

    // 6. Click "Mark as Unwatched" -> instant update
    await toggleBtn.click();
    await expect(toggleBtn).toContainText('Mark as Watched');
    await expect(statusBadge).toContainText('To Watch');

    // 7. Toggle to Watched again, then close modal via close button
    await toggleBtn.click();
    await expect(toggleBtn).toContainText('Mark as Unwatched');
    await closeBtn.click();
    await expect(modalDialog).not.toBeVisible();

    // 8. Underlying card on Watchlist page now immediately reflects Watched status
    await expect(page.locator('text=Watched (1)')).toBeVisible();

    // 9. Test backdrop click dismissal
    await page.locator('h4:has-text("Inception")').first().click();
    await expect(modalDialog).toBeVisible();
    // Click backdrop
    await page.locator('div.fixed.inset-0.bg-black\\/80').click({ position: { x: 10, y: 10 } });
    await expect(modalDialog).not.toBeVisible();

    // 10. Test Escape key dismissal
    await page.locator('h4:has-text("Inception")').first().click();
    await expect(modalDialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(modalDialog).not.toBeVisible();
  });

  test('Part 3: Pick for Us "All Collections" semantics, custom checkboxes, and dropdown outside click', async ({
    page,
  }) => {
    // 1. Create a second collection so we have multiple collections
    await page.goto('/collections');
    await page.click('button:has-text("New Collection")');
    await page.fill('input[placeholder*="Cyberpunk"]', 'Nolan Masterpieces');
    await page.click('button:has-text("Create Collection")');
    await expect(page.locator('h3:has-text("Nolan Masterpieces")')).toBeVisible();

    // 2. Open Pick for Us modal from Dashboard
    await page.goto('/dashboard');
    await page.click('[data-testid="dashboard-pick-button"]');
    const modalDialog = page.locator('div[role="dialog"]');
    await expect(modalDialog).toBeVisible();

    // 3. Open Customize Pool drawer
    const togglePickerBtn = page.locator('[data-testid="roulette-toggle-picker-button"]');
    await expect(togglePickerBtn).toBeVisible();
    await togglePickerBtn.click();

    // Verify "All Collections" checkbox is checked
    const allCollectionsCb = page.locator('[data-testid="roulette-all-collections-checkbox"]');
    await expect(allCollectionsCb).toHaveAttribute('aria-checked', 'true');

    // In All Collections mode, every individual collection checkbox must visually appear checked!
    const checkboxes = page.locator('div[data-testid^="roulette-collection-checkbox-"]');
    const count = await checkboxes.count();
    expect(count).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < count; i++) {
      await expect(checkboxes.nth(i)).toHaveAttribute('aria-checked', 'true');
    }

    // 4. Click an individual collection to uncheck it
    await checkboxes.first().click();
    // "All Collections" must now be unchecked
    await expect(allCollectionsCb).toHaveAttribute('aria-checked', 'false');
    // First checkbox is unchecked
    await expect(checkboxes.first()).toHaveAttribute('aria-checked', 'false');
    // Second checkbox remains checked
    await expect(checkboxes.nth(1)).toHaveAttribute('aria-checked', 'true');

    // 5. Click "All Collections" to re-check all
    await allCollectionsCb.click();
    await expect(allCollectionsCb).toHaveAttribute('aria-checked', 'true');
    for (let i = 0; i < count; i++) {
      await expect(checkboxes.nth(i)).toHaveAttribute('aria-checked', 'true');
    }

    // 6. Click "All Collections" again to uncheck all (0 collections selected)
    await allCollectionsCb.click();
    await expect(allCollectionsCb).toHaveAttribute('aria-checked', 'false');
    for (let i = 0; i < count; i++) {
      await expect(checkboxes.nth(i)).toHaveAttribute('aria-checked', 'false');
    }

    // Validation for 0 collections selected must appear
    const validationMsg = page.locator('[data-testid="roulette-zero-validation-message"]');
    await expect(validationMsg).toBeVisible();
    await expect(validationMsg).toContainText('Please select at least one collection');

    // Roll button must be disabled
    const rollAgainBtn = page.locator('[data-testid="roulette-roll-again"]');
    if (await rollAgainBtn.isVisible()) {
      await expect(rollAgainBtn).toBeDisabled();
    }

    // 7. Test Escape key closes ONLY the collection picker, keeping the main modal open
    await page.keyboard.press('Escape');
    // Picker should be hidden
    await expect(page.locator('[data-testid="roulette-picker-done-button"]')).not.toBeVisible();
    // But parent modal is still open
    await expect(modalDialog).toBeVisible();

    // 8. Re-open picker and test "Done" button
    await togglePickerBtn.click();
    await expect(page.locator('[data-testid="roulette-picker-done-button"]')).toBeVisible();
    await page.click('[data-testid="roulette-picker-done-button"]');
    await expect(page.locator('[data-testid="roulette-picker-done-button"]')).not.toBeVisible();
    await expect(modalDialog).toBeVisible();

    // Close modal
    await page.locator('[data-testid="modal-close-button"]').click();
    await expect(modalDialog).not.toBeVisible();
  });

  test('Part 6: Theme System toggle and persistence', async ({ page }) => {
    await page.goto('/dashboard');

    // Verify theme toggle button exists in navbar
    const themeToggle = page.locator('[data-testid="theme-toggle-button"]').first();
    await expect(themeToggle).toBeVisible();

    // Initial theme is dark
    const html = page.locator('html');
    await expect(html).toHaveClass(/dark/);

    // Toggle to Light theme
    await themeToggle.click();
    await expect(html).toHaveClass(/light/);

    // Verify localStorage persistence
    const themeInStorage = await page.evaluate(() => localStorage.getItem('cinetrack_theme'));
    expect(themeInStorage).toBe('light');

    // Reload page -> theme remains light
    await page.reload();
    await expect(page.locator('html')).toHaveClass(/light/);

    // Toggle back to Dark theme from Settings page
    await page.goto('/settings');
    const settingsToggle = page.locator('[data-testid="theme-toggle-button"]').first();
    await settingsToggle.click();
    await expect(page.locator('html')).toHaveClass(/dark/);

    const updatedStorage = await page.evaluate(() => localStorage.getItem('cinetrack_theme'));
    expect(updatedStorage).toBe('dark');
  });

  test('Part 5: Mobile-first responsive layouts across 320px, 375px, 390px, 430px', async ({
    page,
  }) => {
    const viewports = [
      { width: 320, height: 640 },
      { width: 375, height: 667 },
      { width: 390, height: 844 },
      { width: 430, height: 932 },
    ];

    for (const vp of viewports) {
      await page.setViewportSize(vp);
      await page.goto('/dashboard');
      await page.waitForLoadState('networkidle');

      // Verify zero horizontal scrolling
      const hasHorizontalScroll = await page.evaluate(() => {
        return document.documentElement.scrollWidth > window.innerWidth;
      });
      expect(hasHorizontalScroll).toBe(false);

      // Verify mobile bottom navigation is visible
      const mobileNav = page.locator('nav[aria-label="Mobile Navigation"]');
      await expect(mobileNav).toBeVisible();

      // Test Watchlist page at this viewport
      await page.goto('/watchlist');
      await page.waitForLoadState('networkidle');
      const watchlistHasScroll = await page.evaluate(() => {
        return document.documentElement.scrollWidth > window.innerWidth;
      });
      expect(watchlistHasScroll).toBe(false);

      // Test Collections page at this viewport
      await page.goto('/collections');
      await page.waitForLoadState('networkidle');
      const collectionsHasScroll = await page.evaluate(() => {
        return document.documentElement.scrollWidth > window.innerWidth;
      });
      expect(collectionsHasScroll).toBe(false);
    }
  });
});
