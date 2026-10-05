/*
  Hand-edited after `prisma migrate dev --create-only` (docs/api/rider-register.md, Migration impact).
  Prisma's generated SQL dropped firstName and lastName, added fullName NOT NULL in one step, and
  dropped and recreated gender, which would fail or lose data on a table that has rows. The dev Rider
  table had 0 rows when this was written, but this version is safe either way:
  - fullName is added nullable, filled from firstName + lastName (cut at 100 characters), then set
    NOT NULL, and only then are the old columns dropped (the last statement of the Rider changes).
  - gender is converted in place with a cast, so a value that is not MALE, FEMALE or OTHER makes the
    migration fail loudly instead of being lost.
  - timestamp columns become timestamptz by reading the stored values as UTC (Prisma stores UTC).
  Destructive statements: DROP COLUMN "firstName" and "lastName" (after their data is copied into fullName).
*/
-- CreateEnum
CREATE TYPE "OtpPurpose" AS ENUM ('RIDER_AUTH');

-- CreateEnum
CREATE TYPE "DevicePlatform" AS ENUM ('ANDROID', 'IOS');

-- CreateEnum
CREATE TYPE "RiderStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'BLOCKED', 'DELETED');

-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('MALE', 'FEMALE', 'OTHER');

-- AlterTable: Rider, step 1, the new name column (nullable first)
ALTER TABLE "Rider" ADD COLUMN "fullName" VARCHAR(100);

-- Rider, step 2, copy the old names (firstName, a space, then lastName when it is not null)
UPDATE "Rider" SET "fullName" = left(btrim(concat_ws(' ', "firstName", "lastName")), 100);

-- Rider, step 3, now the column can be required
ALTER TABLE "Rider" ALTER COLUMN "fullName" SET NOT NULL;

-- Rider, step 4, the other new columns and changed defaults
ALTER TABLE "Rider"
ADD COLUMN     "deletedAt" TIMESTAMPTZ(3),
ADD COLUMN     "isEmailVerified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "lastLoginAt" TIMESTAMPTZ(3),
ADD COLUMN     "registeredCity" TEXT,
ADD COLUMN     "registeredState" TEXT,
ADD COLUMN     "status" "RiderStatus" NOT NULL DEFAULT 'ACTIVE',
ALTER COLUMN "isPhoneVerified" SET DEFAULT false;

-- Rider, step 5, column type changes that keep the stored values
ALTER TABLE "Rider" ALTER COLUMN "gender" TYPE "Gender" USING "gender"::"Gender";
ALTER TABLE "Rider" ALTER COLUMN "dateOfBirth" SET DATA TYPE DATE USING "dateOfBirth"::date;
ALTER TABLE "Rider" ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC';
ALTER TABLE "Rider" ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMPTZ(3) USING "updatedAt" AT TIME ZONE 'UTC';

-- Rider, step 6, last: drop the old name columns (their data is already in fullName)
ALTER TABLE "Rider" DROP COLUMN "firstName", DROP COLUMN "lastName";

-- CreateTable
CREATE TABLE "OtpSession" (
    "id" TEXT NOT NULL,
    "phoneNumber" TEXT NOT NULL,
    "purpose" "OtpPurpose" NOT NULL,
    "providerSessionId" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "verifiedAt" TIMESTAMPTZ(3),
    "consumedAt" TIMESTAMPTZ(3),
    "registrationTokenHash" TEXT,
    "registrationExpiresAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OtpSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Device" (
    "id" TEXT NOT NULL,
    "riderId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "platform" "DevicePlatform" NOT NULL,
    "appVersion" TEXT NOT NULL,
    "fcmToken" TEXT,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefreshToken" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "riderId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OtpSession_registrationTokenHash_key" ON "OtpSession"("registrationTokenHash");

-- CreateIndex
CREATE INDEX "OtpSession_phoneNumber_createdAt_idx" ON "OtpSession"("phoneNumber", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Device_riderId_deviceId_key" ON "Device"("riderId", "deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");

-- CreateIndex
CREATE INDEX "RefreshToken_riderId_deviceId_idx" ON "RefreshToken"("riderId", "deviceId");

-- CreateIndex
CREATE INDEX "Rider_status_idx" ON "Rider"("status");

-- CreateIndex
CREATE INDEX "Rider_createdAt_idx" ON "Rider"("createdAt");

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_riderId_fkey" FOREIGN KEY ("riderId") REFERENCES "Rider"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_riderId_deviceId_fkey" FOREIGN KEY ("riderId", "deviceId") REFERENCES "Device"("riderId", "deviceId") ON DELETE CASCADE ON UPDATE CASCADE;
