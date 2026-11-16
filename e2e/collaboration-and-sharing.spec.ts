import { test, expect } from '@playwright/test';

test.describe('E2E: Collaboration & Public Sharing Workflows', () => {
  const timestamp = Date.now();
  const owner = {
    username: `host_${timestamp}`,
    email: `host_${timestamp}@cinetrack.local`,
    password: 'Password123!',
  };
  const friend = {
    username: `friend_${timestamp}`,
    email: `friend_${timestamp}@cinetrack.local`,
    password: 'Password123!',
  };

  test('should handle public collection sharing and multi-user collaboration end-to-end', async ({
    browser,
  }) => {
    // ------------------------------------------------------------------------
    // Part 1: Owner creates collection, adds a movie, and enables public sharing
    // ------------------------------------------------------------------------
    const ownerContext = await browser.newContext();
    const ownerPage = await ownerContext.newPage();

    // Register friend first
    const friendContext = await browser.newContext();
    const friendPage = await friendContext.newPage();
    await friendPage.goto('/register');
    await friendPage.fill('input[type="text"]', friend.username);
    await friendPage.fill('input[type="email"]', friend.email);
    await friendPage.locator('input[type="password"]').first().fill(friend.password);
    await friendPage.locator('input[type="password"]').nth(1).fill(friend.password);
    await friendPage.click('button:has-text("Create Account")');
    await expect(friendPage).toHaveURL(/.*\/dashboard/);

    // Register owner
    await ownerPage.goto('/register');
    await ownerPage.fill('input[type="text"]', owner.username);
    await ownerPage.fill('input[type="email"]', owner.email);
    await ownerPage.locator('input[type="password"]').first().fill(owner.password);
    await ownerPage.locator('input[type="password"]').nth(1).fill(owner.password);
    await ownerPage.click('button:has-text("Create Account")');
    await expect(ownerPage).toHaveURL(/.*\/dashboard/);

    // Owner creates custom collection
    await ownerPage.click('a:has-text("Collections")');
    await ownerPage.click('button:has-text("New Collection")');
    await ownerPage.fill('input[placeholder*="Cyberpunk"]', 'Midnight Club');
    await ownerPage.click('button:has-text("Create Collection")');

    const colCard = ownerPage.locator('h3:has-text("Midnight Club")');
    await expect(colCard).toBeVisible();
    await colCard.click();

    // Owner adds movie
    await ownerPage.click('button:has-text("Add Movies")');
    await ownerPage.locator('input[placeholder*="Search by title"]').fill('The Matrix');
    const addButton = ownerPage.locator('[data-testid="modal-add-button"]').first();
    await expect(addButton).toBeVisible({ timeout: 10000 });
    await addButton.click();
    await ownerPage.keyboard.press('Escape');
    await expect(ownerPage.locator('h4:has-text("The Matrix")').first()).toBeVisible();

    // Owner enables public sharing
    await ownerPage.click('button:has-text("Share")');
    await expect(ownerPage.locator('text=Share Collection')).toBeVisible();
    await ownerPage.click('button:has-text("Enable Public Sharing")');
    await expect(ownerPage.locator('text=Public Link is Active')).toBeVisible({ timeout: 5000 });

    // Read the share URL from the input
    const shareUrlInput = ownerPage.locator('input[readonly]');
    const shareUrl = await shareUrlInput.inputValue();
    expect(shareUrl).toContain('/c/');
    await ownerPage.click('button:has-text("Done")');

    // ------------------------------------------------------------------------
    // Part 2: Open public view-only link in an unauthenticated guest context
    // ------------------------------------------------------------------------
    const guestContext = await browser.newContext();
    const guestPage = await guestContext.newPage();
    await guestPage.goto(shareUrl);

    // Verify public visitor view
    await expect(guestPage.locator('h1:has-text("Midnight Club")')).toBeVisible();
    await expect(guestPage.locator(`text=@${owner.username}`)).toBeVisible();
    await expect(guestPage.locator('h4:has-text("The Matrix")')).toBeVisible();
    // Verify guest has NO modification buttons
    await expect(guestPage.locator('button:has-text("Add Movies")')).not.toBeVisible();
    await expect(guestPage.locator('button:has-text("Delete")')).not.toBeVisible();

    // ------------------------------------------------------------------------
    // Part 3: Owner invites Friend to collaborate
    // ------------------------------------------------------------------------
    await ownerPage.click('button:has-text("Collaborators")');
    await ownerPage.fill('input[placeholder*="username or email"]', friend.username);
    await ownerPage.click('button:has-text("Send Invite")');
    await expect(ownerPage.locator('text=Invitation sent successfully!')).toBeVisible({
      timeout: 5000,
    });
    await ownerPage.keyboard.press('Escape');

    // ------------------------------------------------------------------------
    // Part 4: Friend receives invitation, accepts it, and views shared collection
    // ------------------------------------------------------------------------
    await friendPage.goto('/invitations');
    await expect(friendPage.locator('h3:has-text("Midnight Club")')).toBeVisible();
    await expect(friendPage.locator(`text=@${owner.username}`)).toBeVisible();

    // Friend accepts invitation
    await friendPage.click('button:has-text("Accept Invitation")');
    await expect(friendPage.locator('text=Accepted invitation')).toBeVisible({ timeout: 5000 });

    // Friend checks "Shared With Me"
    await friendPage.click('a:has-text("Shared")');
    await expect(friendPage.locator('h3:has-text("Midnight Club")')).toBeVisible();
    await friendPage.click('h3:has-text("Midnight Club")');

    // Verify Friend sees "Collaborator" badge and can view Matrix
    await expect(friendPage.locator('span:has-text("Collaborator")').first()).toBeVisible();
    await expect(friendPage.locator('h4:has-text("The Matrix")').first()).toBeVisible();

    // Verify Friend CANNOT delete the collection (delete button is owner-only)
    await expect(friendPage.locator('button[title="Delete collection"]')).not.toBeVisible();

    // ------------------------------------------------------------------------
    // Part 5: Owner revokes public link -> Guest gets 404
    // ------------------------------------------------------------------------
    await ownerPage.click('button:has-text("Share")');
    await ownerPage.click('button:has-text("Disable Public Link")');
    await expect(ownerPage.locator('text=Collection is currently Private')).toBeVisible({
      timeout: 5000,
    });

    // Guest reloads -> gets 404
    await guestPage.reload();
    await expect(guestPage.locator('text=Collection Not Found or Link Expired')).toBeVisible();

    await ownerContext.close();
    await friendContext.close();
    await guestContext.close();
  });
});
