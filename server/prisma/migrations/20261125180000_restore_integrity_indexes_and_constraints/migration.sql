-- Restore database invariants required by authentication, watchlist ownership, and backup preflight.
-- These indexes intentionally reject case-only duplicate usernames/emails.
CREATE UNIQUE INDEX "User_username_lower_key" ON "User" (LOWER("username"));
CREATE UNIQUE INDEX "User_email_lower_key" ON "User" (LOWER("email"));

-- A user may have at most one default watchlist.
CREATE UNIQUE INDEX "Collection_owner_default_watchlist_key"
ON "Collection" ("ownerId")
WHERE "isDefaultWatchlist" = true;

-- Keep legacy collection-entry status columns internally consistent.
-- User-facing watched status is stored separately in UserMovieWatchStatus.
ALTER TABLE "CollectionMovie"
ADD CONSTRAINT "CollectionMovie_status_watchedAt_check"
CHECK (
  ("status" = 'WATCHED' AND "watchedAt" IS NOT NULL)
  OR
  ("status" = 'TO_WATCH' AND "watchedAt" IS NULL)
);
