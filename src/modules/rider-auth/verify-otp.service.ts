import { Inject, Injectable } from '@nestjs/common';
import { OtpPurpose, RiderStatus } from '@prisma/client';
import { CLOCK, type Clock } from '../../common/clock.js';
import { AppException } from '../../common/errors/app.exception.js';
import { newOpaqueToken, sha256Hex } from '../../common/tokens.js';
import { REFRESH_TOKEN_TTL_SECONDS, REGISTRATION_TOKEN_TTL_SECONDS } from '../../config/tokens.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AccessTokenService } from '../../common/jwt/access-token.service.js';
import type { VerifyOtpDto } from '../otp/dto/verify-otp.dto.js';
import { markCodeUsed, OtpCodeChecker } from '../otp/otp-code-checker.js';
import { OTP_PROVIDER, type OtpProvider } from '../otp/provider/otp-provider.js';
import { riderView, type RiderView } from './rider-view.js';

export interface LoginResult {
  isNewRider: false;
  rider: RiderView;
  tokens: {
    accessToken: string;
    accessTokenExpiresInSeconds: number;
    refreshToken: string;
    refreshTokenExpiresInSeconds: number;
  };
}

export interface NewRiderResult {
  isNewRider: true;
  registrationToken: string;
  registrationTokenExpiresInSeconds: number;
}

export type VerifyOtpResult = LoginResult | NewRiderResult;

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
    // the same write that stores the registration token hash, so a failure cannot burn the code
    // without issuing a token.
    if (!rider) return this.issueRegistrationToken(session.id, now);

    await markCodeUsed(this.prisma, session.id, now);

    if (rider.status !== RiderStatus.ACTIVE) {
      await this.prisma.otpSession.update({ where: { id: session.id }, data: { consumedAt: now } });
      throw new AppException('ACCOUNT_BANNED');
    }
    return this.login(rider.id, session.id, dto, now);
  }

  // A phone with no rider gets a one-time registration token. Only its SHA-256 hash is stored.
  // One conditional write marks the code used and stores the hash together (a single statement is
  // atomic, so no transaction is needed). No row changed: another request used the code first.
  private async issueRegistrationToken(sessionId: string, now: Date): Promise<NewRiderResult> {
    const registrationToken = newOpaqueToken();
    const issued = await this.prisma.otpSession.updateMany({
      where: { id: sessionId, verifiedAt: null },
      data: {
        verifiedAt: now,
        registrationTokenHash: sha256Hex(registrationToken),
        registrationExpiresAt: new Date(now.getTime() + REGISTRATION_TOKEN_TTL_SECONDS * 1000),
      },
    });
    if (issued.count === 0) throw new AppException('OTP_INVALID', { field: 'otp' });
    return {
      isNewRider: true,
      registrationToken,
      registrationTokenExpiresInSeconds: REGISTRATION_TOKEN_TTL_SECONDS,
    };
  }

  // Login for an ACTIVE rider: device, refresh token, lastLoginAt and consumedAt change together
  // or not at all (one transaction).
  private async login(riderId: string, sessionId: string, dto: VerifyOtpDto, now: Date): Promise<LoginResult> {
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

    const access = this.accessTokens.issue({ riderId, deviceId: device.deviceId, now });
    return {
      isNewRider: false,
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
