-- AlterTable
ALTER TABLE "Rider" ADD COLUMN     "registeredAddress" TEXT,
ADD COLUMN     "termsAcceptedAt" TIMESTAMPTZ(3),
ADD COLUMN     "termsVersion" TEXT;
