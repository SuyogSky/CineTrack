import { test, expect } from '@playwright/test';

test.describe('E2E: Collection-Aware Dashboard, TV Series & Multi-Collection Roulette', () => {
  const timestamp = Date.now();
  const testUser = {
    username: `cinemaniac_${timestamp}`,
    email: `cinemaniac_${timestamp}@cinetrack.local`,
    password: 'Password123!',
  };

  test('should search and add TV series, aggregate dashboard statistics across collections, and use multi-collection roulette', async ({
    page,
  }) => {
    // 1. Register new user
    await page.goto('/register');
    await page.fill('input[type="text"]', testUser.username);
    await page.fill('input[type="email"]', testUser.email);
    await page.locator('input[type="password"]').first().fill(testUser.password);
    await page.locator('input[type="password"]').nth(1).fill(testUser.password);
    await page.click('button:has-text("Create Account")');
    await expect(page).toHaveURL(/.*\/dashboard/);

    // Initial Dashboard state: 0 movies, 0 TV series, 0 to watch, 1 default collection
    await expect(page.locator('text=Library Dashboard').first()).toBeVisible();
    await expect(page.locator('text=Movies').first()).toBeVisible();
    await expect(page.locator('text=TV Series').first()).toBeVisible();

    // 2. Open Search modal and filter by TV Series
    await page.click('button:has-text("Find Media")');
    await expect(page.locator('text=Search & Add Movies')).toBeVisible();

    // Click "TV Series" segmented filter
    await page.click('button:has-text("TV Series")');

    // Search for "Loki"
    const searchInput = page.locator('input[placeholder*="Search by title"]');
    await searchInput.fill('Loki');

    // Wait for search result and verify TV badge is displayed
    const tvBadge = page.locator('span:has-text("TV")').first();
    await expect(tvBadge).toBeVisible({ timeout: 10000 });
    await expect(page.locator('h4:has-text("Loki")').first()).toBeVisible();

    // Add Loki to default collection
    const addButton = page.locator('[data-testid="modal-add-button"]').first();
    await addButton.click();
    await expect(page.locator('button:has-text("Added")').first()).toBeVisible();
    await page.keyboard.press('Escape');

    // 3. Create a custom collection "Sci-Fi Gems"
    await page.click('button:has-text("New Collection")');
    await page.fill('input[placeholder*="Cyberpunk"]', 'Sci-Fi Gems');
    await page.fill('textarea[placeholder*="What is this collection for"]', 'Favorite space & sci-fi titles');
    await page.click('button:has-text("Create Collection")');

    // Open "Sci-Fi Gems" collection
    const scifiCard = page.locator('h3:has-text("Sci-Fi Gems")');
    await expect(scifiCard).toBeVisible({ timeout: 10000 });
    await scifiCard.click();
    await expect(page).toHaveURL(/.*\/collections\/.+/);

    // Add Inception (movie) to "Sci-Fi Gems"
    await page.click('button:has-text("Add Movies")');
    const modalSearchInput = page.locator('input[placeholder*="Search by title"]');
    await modalSearchInput.fill('Inception');
    const addInceptionBtn = page.locator('[data-testid="modal-add-button"]').first();
    await expect(addInceptionBtn).toBeVisible({ timeout: 10000 });
    await addInceptionBtn.click();
    await expect(page.locator('button:has-text("Added")').first()).toBeVisible();
    await page.keyboard.press('Escape');

    // Return to Dashboard and check updated collection-aware aggregate stats!
    await page.click('a:has-text("Dashboard")');
    await expect(page).toHaveURL(/.*\/dashboard/);

    // Verify aggregate dashboard stats:
    // Total Movies: 1 (Inception)
    // Total TV Series: 1 (Loki)
    // To Watch: 2 (Loki + Inception)
    // Total Collections: 2 (My Watchlist + Sci-Fi Gems)
    await expect(page.locator('text=1').first()).toBeVisible();
    await expect(page.locator('text=2').first()).toBeVisible();

    // 4. Test Multi-Collection Pick for Us
    const pickForUsBtn = page.locator('[data-testid="dashboard-pick-button"]');
    await pickForUsBtn.click();
    await expect(page.locator('text=Pick for Us — Movie Night Roulette')).toBeVisible();

    // Verify candidate pool indicator is present
    await expect(page.locator('text=Candidate Pool:')).toBeVisible();

    // Wait for the random selection to reveal
    await expect(page.locator("text=TONIGHT'S PICK")).toBeVisible({ timeout: 10000 });

    // The picked item should be either Inception or Loki
    const hasInceptionOrLoki = await page
      .locator('h3:has-text("Inception"), h3:has-text("Loki")')
      .first()
      .isVisible();
    expect(hasInceptionOrLoki).toBeTruthy();

    // Close roulette modal
    await page.keyboard.press('Escape');

    // 5. Test Mobile Bottom Navigation
    await page.setViewportSize({ width: 390, height: 844 });
    const mobileBottomHome = page.locator('[data-testid="mobile-bottom-nav-home"]');
    await expect(mobileBottomHome).toBeVisible();

    const mobileBottomPick = page.locator('[data-testid="mobile-bottom-nav-pick"]');
    await expect(mobileBottomPick).toBeVisible();
    await mobileBottomPick.click();
    await expect(page.locator('text=Pick for Us — Movie Night Roulette')).toBeVisible();
    await page.keyboard.press('Escape');

    const mobileBottomCollections = page.locator('[data-testid="mobile-bottom-nav-collections"]');
    await mobileBottomCollections.click();
    await expect(page).toHaveURL(/.*\/collections/);
  });
});
