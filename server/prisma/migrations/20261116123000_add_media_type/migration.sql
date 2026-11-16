-- CreateEnum
CREATE TYPE "MediaType" AS ENUM ('MOVIE', 'TV');

-- DropIndex
DROP INDEX IF EXISTS "Movie_tmdbId_idx";

-- DropIndex
DROP INDEX IF EXISTS "Movie_tmdbId_key";

-- AlterTable
ALTER TABLE "Movie" ADD COLUMN "mediaType" "MediaType" NOT NULL DEFAULT 'MOVIE';

-- CreateIndex
CREATE INDEX "Movie_tmdbId_mediaType_idx" ON "Movie"("tmdbId", "mediaType");

-- CreateIndex
CREATE INDEX "Movie_mediaType_idx" ON "Movie"("mediaType");

-- CreateIndex
CREATE UNIQUE INDEX "Movie_tmdbId_mediaType_key" ON "Movie"("tmdbId", "mediaType");
