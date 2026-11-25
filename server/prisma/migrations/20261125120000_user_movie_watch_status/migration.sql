-- Create personal movie watch status.
-- Each user has exactly one status per canonical movie.

CREATE TABLE "UserMovieWatchStatus" (
    "userId" TEXT NOT NULL,
    "movieId" TEXT NOT NULL,
    "status" "WatchStatus" NOT NULL DEFAULT 'TO_WATCH',
    "watchedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserMovieWatchStatus_pkey"
        PRIMARY KEY ("userId", "movieId"),

    CONSTRAINT "UserMovieWatchStatus_status_watchedAt_check"
        CHECK (
            ("status" = 'WATCHED' AND "watchedAt" IS NOT NULL)
            OR
            ("status" = 'TO_WATCH' AND "watchedAt" IS NULL)
        ),

    CONSTRAINT "UserMovieWatchStatus_userId_fkey"
        FOREIGN KEY ("userId")
        REFERENCES "User"("id")
        ON DELETE CASCADE
        ON UPDATE CASCADE,

    CONSTRAINT "UserMovieWatchStatus_movieId_fkey"
        FOREIGN KEY ("movieId")
        REFERENCES "Movie"("id")
        ON DELETE CASCADE
        ON UPDATE CASCADE
);

CREATE INDEX "UserMovieWatchStatus_movieId_idx"
    ON "UserMovieWatchStatus"("movieId");

CREATE INDEX "UserMovieWatchStatus_userId_status_idx"
    ON "UserMovieWatchStatus"("userId", "status");


-- Preserve existing WATCHED entries.
-- Historical CollectionMovie status is shared and cannot tell us
-- which collaborator originally changed it. Preserve it as the
-- collection owner's status rather than discard existing watched data.

INSERT INTO "UserMovieWatchStatus" (
    "userId",
    "movieId",
    "status",
    "watchedAt",
    "createdAt",
    "updatedAt"
)
SELECT
    c."ownerId",
    cm."movieId",
    'WATCHED'::"WatchStatus",
    MIN(cm."watchedAt"),
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "CollectionMovie" cm
INNER JOIN "Collection" c
    ON c."id" = cm."collectionId"
WHERE cm."status" = 'WATCHED'
GROUP BY c."ownerId", cm."movieId"
ON CONFLICT ("userId", "movieId")
DO UPDATE SET
    "status" = 'WATCHED',
    "watchedAt" = LEAST(
        "UserMovieWatchStatus"."watchedAt",
        EXCLUDED."watchedAt"
    ),
    "updatedAt" = CURRENT_TIMESTAMP;