-- Enforce consistency between status and watchedAt on CollectionMovie at the database level:
-- WATCHED requires a non-null watchedAt
-- TO_WATCH requires a null watchedAt
ALTER TABLE "CollectionMovie" 
ADD CONSTRAINT "CollectionMovie_status_watchedAt_check" 
CHECK (
  ("status" = 'WATCHED' AND "watchedAt" IS NOT NULL) OR 
  ("status" = 'TO_WATCH' AND "watchedAt" IS NULL)
);
