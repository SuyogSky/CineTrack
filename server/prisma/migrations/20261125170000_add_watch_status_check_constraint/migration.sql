
ALTER TABLE "UserMovieWatchStatus"
ADD CONSTRAINT "UserMovieWatchStatus_status_watchedAt_check"
CHECK (
    ("status" = 'WATCHED' AND "watchedAt" IS NOT NULL)
    OR
    ("status" = 'TO_WATCH' AND "watchedAt" IS NULL)
);
