-- AlterTable
ALTER TABLE "DocumentRequirement" ADD COLUMN     "comingSoonOptions" TEXT[] DEFAULT ARRAY[]::TEXT[];
