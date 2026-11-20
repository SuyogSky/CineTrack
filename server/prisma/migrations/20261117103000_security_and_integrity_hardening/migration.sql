-- AlterTable
ALTER TABLE "Session" ADD COLUMN IF NOT EXISTS "previousTokenHash" TEXT;
ALTER TABLE "Session" ADD COLUMN IF NOT EXISTS "rotatedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Session_previousTokenHash_idx" ON "Session"("previousTokenHash");

-- Enforce case-insensitive username and email uniqueness at the database level
CREATE UNIQUE INDEX IF NOT EXISTS "User_username_lower_key" ON "User"(LOWER("username"));
CREATE UNIQUE INDEX IF NOT EXISTS "User_email_lower_key" ON "User"(LOWER("email"));

-- Enforce exactly one default watchlist per user at the database level
CREATE UNIQUE INDEX IF NOT EXISTS "Collection_owner_default_watchlist_key" ON "Collection"("ownerId") WHERE "isDefaultWatchlist" = true;
