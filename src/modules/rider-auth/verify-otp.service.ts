import { Inject, Injectable } from '@nestjs/common';
import { OtpPurpose, RiderStatus, type Rider } from '@prisma/client';
import { CLOCK, type Clock } from '../../common/clock.js';
import { violatedUniqueIndex } from '../../common/database/unique-violation.js';
import { AppException } from '../../common/errors/app.exception.js';
import { newOpaqueToken, sha256Hex } from '../../common/tokens.js';
import { REFRESH_TOKEN_TTL_SECONDS } from '../../config/tokens.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AccessTokenService, type AuthTokens } from '../../common/jwt/access-token.service.js';
import type { VerifyOtpDto } from '../otp/dto/verify-otp.dto.js';
import { markCodeUsed, OtpCodeChecker } from '../otp/otp-code-checker.js';
import { OTP_PROVIDER, type OtpProvider } from '../otp/provider/otp-provider.js';
import { riderView, type RiderView } from './rider-view.js';

// One shape for a new and an existing rider (docs/api/rider-verify-otp.md, Response fields).
export interface VerifyOtpResult {
  isNewRider: boolean;
  rider: RiderView;
  tokens: AuthTokens;
}

@Injectable()
export class VerifyOtpService {
  private readonly codeChecker: OtpCodeChecker;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(OTP_PROVIDER) otpProvider: OtpProvider,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly accessTokens: AccessTokenService,
  ) {
    this.codeChecker = new OtpCodeChecker(prisma, otpProvider);
  }

  // docs/api/rider-verify-otp.md, "Order of operations".
  async verifyOtp(dto: VerifyOtpDto): Promise<VerifyOtpResult> {
    const now = this.clock();
    const { phoneNumber } = dto;

    // 2 to 5. Limit, newest RIDER_AUTH session, usable checks, reserve an attempt, provider verify
    // (give-back on provider failure): shared with the driver route. A driver session for the same
    // phone is never read here, so a driver code cannot log a rider in.
    const session = await this.codeChecker.check(OtpPurpose.RIDER_AUTH, phoneNumber, dto.otp, now);

    // 6. Only now, after the caller proved they hold the phone, does the account state matter.
    const rider = await this.prisma.rider.findUnique({ where: { phoneNumber } });

    // 7. Single use: only one request can turn verifiedAt from empty to set. For a new phone this is
    // the first write of the transaction that creates the rider, so a failure cannot burn the code.
    if (!rider) return this.createRider(session.id, dto, now);

    await markCodeUsed(this.prisma, session.id, now);

    // A rider who has not finished the profile (PROFILE_PENDING) logs in like any other.
    if (rider.status !== RiderStatus.ACTIVE && rider.status !== RiderStatus.PROFILE_PENDING) {
      await this.prisma.otpSession.update({ where: { id: session.id }, data: { consumedAt: now } });
      throw new AppException('ACCOUNT_BANNED');
    }
    return this.login(rider.id, session.id, dto, now);
  }

  // A phone with no rider: ONE transaction marks the code used, creates the Rider (PROFILE_PENDING, no
  // name or email yet), the device and the refresh token. If any step fails nothing is written and the
  // code stays usable. In Express terms, a Mongo multi-document transaction. The reply has the same
  // shape as a login, with isNewRider true.
  private async createRider(sessionId: string, dto: VerifyOtpDto, now: Date): Promise<VerifyOtpResult> {
    const { device } = dto;
    const refreshToken = newOpaqueToken();

    let rider: Rider;
    try {
      rider = await this.prisma.$transaction(async (tx) => {
        // The single-use step first: a parallel request waits here, then matches no row.
        await markCodeUsed(tx, sessionId, now, { consumedAt: now });
        const created = await tx.rider.create({
          data: {
            phoneNumber: dto.phoneNumber,
            fullName: null,
            email: null,
            status: RiderStatus.PROFILE_PENDING,
            isPhoneVerified: true,
            isProfileComplete: false,
            lastLoginAt: now, // creating the account counts as the first login
            createdAt: now,
            updatedAt: now,
          },
        });
        await tx.device.create({
          data: {
            riderId: created.id,
            deviceId: device.deviceId,
            platform: device.platform,
            appVersion: device.appVersion,
            fcmToken: device.fcmToken ?? null,
            lastSeenAt: now,
          },
        });
        await tx.refreshToken.create({
          data: {
            tokenHash: sha256Hex(refreshToken),
            riderId: created.id,
            deviceId: device.deviceId,
            expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_SECONDS * 1000),
            createdAt: now,
          },
        });
        return created;
      });
    } catch (error) {
      // Another session created this phone's Rider first; the transaction rolled back, so the code is not used.
      if (violatedUniqueIndex(error) === 'phoneNumber') throw new AppException('CONFLICT');
      throw error;
    }
    return this.reply(true, rider, refreshToken, dto.device.deviceId, now);
  }

  // Login for an ACTIVE or PROFILE_PENDING rider: device, refresh token, lastLoginAt and consumedAt change together
  // or not at all (one transaction).
  private async login(riderId: string, sessionId: string, dto: VerifyOtpDto, now: Date): Promise<VerifyOtpResult> {
    const { device } = dto;
    const refreshToken = newOpaqueToken();

    const rider = await this.prisma.$transaction(async (tx) => {
      await tx.device.upsert({
        where: { riderId_deviceId: { riderId, deviceId: device.deviceId } },
        create: {
          riderId,
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
      await tx.refreshToken.updateMany({ where: { riderId, deviceId: device.deviceId, revokedAt: null }, data: { revokedAt: now } });
      await tx.refreshToken.create({
        data: {
          tokenHash: sha256Hex(refreshToken),
          riderId,
          deviceId: device.deviceId,
          expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_SECONDS * 1000),
          createdAt: now,
        },
      });
      await tx.otpSession.update({ where: { id: sessionId }, data: { consumedAt: now } });
      return tx.rider.update({ where: { id: riderId }, data: { lastLoginAt: now } });
    });

    return this.reply(false, rider, refreshToken, device.deviceId, now);
  }

  private reply(isNewRider: boolean, rider: Rider, refreshToken: string, deviceId: string, now: Date): VerifyOtpResult {
    const access = this.accessTokens.issue({ riderId: rider.id, deviceId, now });
    return {
      isNewRider,
      rider: riderView(rider),
      tokens: {
        accessToken: access.token,
        accessTokenExpiresInSeconds: access.expiresInSeconds,
        refreshToken,
        refreshTokenExpiresInSeconds: REFRESH_TOKEN_TTL_SECONDS,
      },
    };
  }
}
