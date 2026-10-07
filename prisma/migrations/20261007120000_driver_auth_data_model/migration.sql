-- CreateEnum
CREATE TYPE "DriverStatus" AS ENUM ('DOCUMENTS_PENDING', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'SUSPENDED', 'BLOCKED', 'DELETED');

-- CreateTable
CREATE TABLE "Driver" (
    "id" TEXT NOT NULL,
    "phoneNumber" TEXT NOT NULL,
    "status" "DriverStatus" NOT NULL DEFAULT 'DOCUMENTS_PENDING',
    "isPhoneVerified" BOOLEAN NOT NULL DEFAULT false,
    "lastLoginAt" TIMESTAMPTZ(3),
    "deletedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Driver_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DriverDevice" (
    "id" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "platform" "DevicePlatform" NOT NULL,
    "appVersion" TEXT NOT NULL,
    "fcmToken" TEXT,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "DriverDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DriverRefreshToken" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DriverRefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Driver_phoneNumber_key" ON "Driver"("phoneNumber");

-- CreateIndex
CREATE UNIQUE INDEX "DriverDevice_driverId_deviceId_key" ON "DriverDevice"("driverId", "deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "DriverRefreshToken_tokenHash_key" ON "DriverRefreshToken"("tokenHash");

-- CreateIndex
CREATE INDEX "DriverRefreshToken_driverId_deviceId_idx" ON "DriverRefreshToken"("driverId", "deviceId");

-- AddForeignKey
ALTER TABLE "DriverDevice" ADD CONSTRAINT "DriverDevice_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriverRefreshToken" ADD CONSTRAINT "DriverRefreshToken_driverId_deviceId_fkey" FOREIGN KEY ("driverId", "deviceId") REFERENCES "DriverDevice"("driverId", "deviceId") ON DELETE CASCADE ON UPDATE CASCADE;

