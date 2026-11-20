-- AlterTable
ALTER TABLE "Session" ADD COLUMN IF NOT EXISTS "historicalTokenHashes" TEXT[] DEFAULT ARRAY[]::TEXT[];
