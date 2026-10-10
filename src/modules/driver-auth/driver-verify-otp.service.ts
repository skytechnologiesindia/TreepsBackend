import { Inject, Injectable } from '@nestjs/common';
import { DriverStatus, OtpPurpose, type Driver } from '@prisma/client';
import { CLOCK, type Clock } from '../../common/clock.js';
import { violatedUniqueIndex } from '../../common/database/unique-violation.js';
import { AppException } from '../../common/errors/app.exception.js';
import { SessionService } from '../../common/session/session.service.js';
import type { SessionTokens } from '../../common/session/session.types.js';
import { DRIVER_ROLE } from '../../config/tokens.js';
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
  tokens: SessionTokens;
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
    private readonly sessions: SessionService,
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
  // created (or its lastLoginAt set), the device is saved and a session is created, or none of
  // it happens and the code stays usable. In Express terms, a Mongo multi-document transaction.
  private async signIn(existing: Driver | null, sessionId: string, dto: VerifyOtpDto, now: Date): Promise<DriverVerifyResult> {
    const { device } = dto;
    let tokens!: SessionTokens;

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
            // A missing or null token keeps the stored one (the rider may have denied the permission this time).
          ...(device.fcmToken != null ? { fcmToken: device.fcmToken } : {}),
          },
        });
        // One active session (decision 174): the session of this device is replaced and every other
        // session of this driver is deleted at once; the other devices' rows go with them. The
        // session table is touched only through SessionService.
        tokens = await this.sessions.create({ role: DRIVER_ROLE, accountId: row.id, deviceId: device.deviceId, now }, tx);
        await this.sessions.deleteAllForAccount(DRIVER_ROLE, row.id, { exceptDeviceId: device.deviceId }, tx);
        await tx.driverDevice.deleteMany({ where: { driverId: row.id, deviceId: { not: device.deviceId } } });
        return row;
      });
    } catch (error) {
      // Another session created this phone's Driver first; the transaction rolled back, so the code is not used.
      if (violatedUniqueIndex(error) === 'phoneNumber') throw new AppException('CONFLICT');
      throw error;
    }

    return { isNewDriver: existing === null, driver: driverView(driver), tokens };
  }
}
