import { test, expect } from '@playwright/test';

test.describe('E2E: Custom Collections & Movie Night Roulette', () => {
  const timestamp = Date.now();
  const testUser = {
    username: `director_${timestamp}`,
    email: `director_${timestamp}@cinetrack.local`,
    password: 'Password123!',
  };

  test('should create custom collection, add movie, spin roulette, and move movie', async ({
    page,
  }) => {
    // 1. Register & Login
    await page.goto('/register');
    await page.fill('input[type="text"]', testUser.username);
    await page.fill('input[type="email"]', testUser.email);
    await page.locator('input[type="password"]').first().fill(testUser.password);
    await page.locator('input[type="password"]').nth(1).fill(testUser.password);
    await page.click('button:has-text("Create Account")');
    await expect(page).toHaveURL(/.*\/dashboard/);

    // 2. Navigate to Collections
    await page.click('a:has-text("Collections")');
    await expect(page).toHaveURL(/.*\/collections/);

    // 3. Create Custom Collection
    await page.click('button:has-text("New Collection")');
    await page.fill('input[placeholder*="Cyberpunk"]', 'Sci-Fi Vault');
    await page.fill('textarea[placeholder*="What is this collection for"]', 'Favorite space films');
    await page.click('button:has-text("Create Collection")');

    // 4. Verify collection is created and click to open
    const collectionCard = page.locator('h3:has-text("Sci-Fi Vault")');
    await expect(collectionCard).toBeVisible();
    await collectionCard.click();
    await expect(page).toHaveURL(/.*\/collections\/.+/);

    // 5. Add a movie to this collection
    await page.click('button:has-text("Add Movies")');
    const searchInput = page.locator('input[placeholder*="Search by title"]');
    await searchInput.fill('Interstellar');
    const addButton = page.locator('[data-testid="modal-add-button"]').first();
    await expect(addButton).toBeVisible({ timeout: 10000 });
    await addButton.click();
    await expect(page.locator('button:has-text("Added")').first()).toBeVisible();
    await page.keyboard.press('Escape');

    // 6. Verify movie is in collection
    await expect(page.locator('h4:has-text("Interstellar")').first()).toBeVisible();

    // 7. Trigger "PICK FOR US" (Movie Night Roulette)
    await page.click('button:has-text("PICK FOR US")');
    await expect(page.locator('text=Movie Night Roulette')).toBeVisible();
    // Wait for the random selection to reveal
    await expect(page.locator("text=TONIGHT'S PICK")).toBeVisible({ timeout: 10000 });
    await expect(page.locator('h3:has-text("Interstellar")')).toBeVisible();

    // Click Roll Again
    await page.click('button:has-text("Roll Again")');
    await expect(page.locator("text=TONIGHT'S PICK")).toBeVisible({ timeout: 10000 });

    // Close roulette modal
    await page.keyboard.press('Escape');
  });
});
