-- Enforce collection-title uniqueness per owner, ignoring case and surrounding whitespace.
-- Abort safely rather than deleting or renaming existing user collections if legacy duplicates exist.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "Collection"
    GROUP BY "ownerId", LOWER(BTRIM("title"))
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Cannot add normalized collection-title uniqueness: duplicate titles exist for at least one owner. Resolve duplicate collection titles manually, then rerun this migration.';
  END IF;
END
$$;

CREATE UNIQUE INDEX "Collection_owner_title_normalized_key"
ON "Collection" ("ownerId", LOWER(BTRIM("title")));
