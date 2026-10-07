import { Inject, Injectable } from '@nestjs/common';
import { DriverStatus, OtpPurpose, type Driver } from '@prisma/client';
import { CLOCK, type Clock } from '../../common/clock.js';
import { violatedUniqueIndex } from '../../common/database/unique-violation.js';
import { AppException } from '../../common/errors/app.exception.js';
import { AccessTokenService, type AuthTokens } from '../../common/jwt/access-token.service.js';
import { newOpaqueToken, sha256Hex } from '../../common/tokens.js';
import { REFRESH_TOKEN_TTL_SECONDS } from '../../config/tokens.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { VerifyOtpDto } from '../otp/dto/verify-otp.dto.js';
import { markCodeUsed, OtpCodeChecker } from '../otp/otp-code-checker.js';
import { OTP_PROVIDER, type OtpProvider } from '../otp/provider/otp-provider.js';

// The driver object in replies (docs/api/driver-verify-otp.md): only these fields.
export function driverView(driver: Driver) {
  return {
    id: driver.id,
    phoneNumber: driver.phoneNumber,
    status: driver.status,
    createdAt: driver.createdAt.toISOString(),
  };
}
export type DriverView = ReturnType<typeof driverView>;

export interface DriverVerifyResult {
  isNewDriver: boolean;
  driver: DriverView;
  tokens: AuthTokens;
}

const BANNED: ReadonlySet<DriverStatus> = new Set([DriverStatus.SUSPENDED, DriverStatus.BLOCKED, DriverStatus.DELETED]);

// docs/api/driver-verify-otp.md. The code check is the same code the rider route runs
// (OtpCodeChecker), with the purpose DRIVER_AUTH, so a rider code can never log a driver in.
@Injectable()
export class DriverVerifyOtpService {
  private readonly codeChecker: OtpCodeChecker;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(OTP_PROVIDER) otpProvider: OtpProvider,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly accessTokens: AccessTokenService,
  ) {
    this.codeChecker = new OtpCodeChecker(prisma, otpProvider);
  }

  async verifyOtp(dto: VerifyOtpDto): Promise<DriverVerifyResult> {
    const now = this.clock();
    const { phoneNumber } = dto;

    // Limit, newest DRIVER_AUTH session, usable checks, reserve an attempt, provider verify.
    const session = await this.codeChecker.check(OtpPurpose.DRIVER_AUTH, phoneNumber, dto.otp, now);

    // Only now, after the caller proved they hold the phone, does the account state matter.
    const existing = await this.prisma.driver.findUnique({ where: { phoneNumber } });
    if (existing && BANNED.has(existing.status)) {
      await markCodeUsed(this.prisma, session.id, now, { consumedAt: now });
      throw new AppException('ACCOUNT_BANNED');
    }
    return this.signIn(existing, session.id, dto, now);
  }

  // One transaction for a new and for an existing driver: the code is marked used, the driver is
  // created (or its lastLoginAt set), the device is saved and a refresh token is issued, or none of
  // it happens and the code stays usable. In Express terms, a Mongo multi-document transaction.
  private async signIn(existing: Driver | null, sessionId: string, dto: VerifyOtpDto, now: Date): Promise<DriverVerifyResult> {
    const { device } = dto;
    const refreshToken = newOpaqueToken();

    let driver: Driver;
    try {
      driver = await this.prisma.$transaction(async (tx) => {
        // The single-use step first: a parallel request waits here, then matches no row.
        await markCodeUsed(tx, sessionId, now, { consumedAt: now });
        const row = existing
          ? await tx.driver.update({ where: { id: existing.id }, data: { lastLoginAt: now } })
          : await tx.driver.create({
              data: {
                phoneNumber: dto.phoneNumber,
                status: DriverStatus.DOCUMENTS_PENDING,
                isPhoneVerified: true,
                lastLoginAt: now, // creating the account counts as the first login
                createdAt: now,
                updatedAt: now,
              },
            });
        await tx.driverDevice.upsert({
          where: { driverId_deviceId: { driverId: row.id, deviceId: device.deviceId } },
          create: {
            driverId: row.id,
            deviceId: device.deviceId,
            platform: device.platform,
            appVersion: device.appVersion,
            fcmToken: device.fcmToken ?? null,
            lastSeenAt: now,
          },
          update: {
            platform: device.platform,
            appVersion: device.appVersion,
            lastSeenAt: now,
            ...(device.fcmToken !== undefined ? { fcmToken: device.fcmToken } : {}),
          },
        });
        // One refresh token per device: the earlier one stops working.
        await tx.driverRefreshToken.updateMany({ where: { driverId: row.id, deviceId: device.deviceId, revokedAt: null }, data: { revokedAt: now } });
        await tx.driverRefreshToken.create({
          data: {
            tokenHash: sha256Hex(refreshToken),
            driverId: row.id,
            deviceId: device.deviceId,
            expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_SECONDS * 1000),
            createdAt: now,
          },
        });
        return row;
      });
    } catch (error) {
      // Another session created this phone's Driver first; the transaction rolled back, so the code is not used.
      if (violatedUniqueIndex(error) === 'phoneNumber') throw new AppException('CONFLICT');
      throw error;
    }

    const access = this.accessTokens.issueForDriver({ driverId: driver.id, deviceId: device.deviceId, now });
    return {
      isNewDriver: existing === null,
      driver: driverView(driver),
      tokens: {
        accessToken: access.token,
        accessTokenExpiresInSeconds: access.expiresInSeconds,
        refreshToken,
        refreshTokenExpiresInSeconds: REFRESH_TOKEN_TTL_SECONDS,
      },
    };
  }
}
