-- AlterTable
ALTER TABLE "DocumentRequirement" ADD COLUMN     "options" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "required" BOOLEAN NOT NULL DEFAULT true;
