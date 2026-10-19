-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "Driver" ADD COLUMN     "dateOfBirth" DATE,
ADD COLUMN     "fullName" VARCHAR(100),
ADD COLUMN     "gender" "Gender",
ADD COLUMN     "profilePhotoPath" TEXT,
ADD COLUMN     "submittedAt" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "DriverDocument" (
    "id" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "option" TEXT,
    "number" TEXT,
    "expiryDate" DATE,
    "frontPath" TEXT,
    "backPath" TEXT,
    "status" "DocumentStatus" NOT NULL DEFAULT 'PENDING',
    "reviewNote" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "DriverDocument_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DriverDocument_driverId_key_key" ON "DriverDocument"("driverId", "key");

-- AddForeignKey
ALTER TABLE "DriverDocument" ADD CONSTRAINT "DriverDocument_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE CASCADE ON UPDATE CASCADE;
