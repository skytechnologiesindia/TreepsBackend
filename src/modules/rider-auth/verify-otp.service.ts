import { Inject, Injectable } from '@nestjs/common';
import { OtpPurpose, RiderStatus, type OtpSession } from '@prisma/client';
import { CLOCK, type Clock } from '../../common/clock.js';
import { AppException } from '../../common/errors/app.exception.js';
import { newOpaqueToken, sha256Hex } from '../../common/tokens.js';
import { MAX_OTP_ATTEMPTS } from '../../config/otp.js';
import { RATE_LIMITS } from '../../config/rate-limits.js';
import { REFRESH_TOKEN_TTL_SECONDS, REGISTRATION_TOKEN_TTL_SECONDS } from '../../config/tokens.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AccessTokenService } from './access-token.service.js';
import type { VerifyOtpDto } from './dto/verify-otp.dto.js';
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
  constructor(
    private readonly prisma: PrismaService,
    @Inject(OTP_PROVIDER) private readonly otpProvider: OtpProvider,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly accessTokens: AccessTokenService,
  ) {}

  // docs/api/rider-verify-otp.md, "Order of operations".
  async verifyOtp(dto: VerifyOtpDto): Promise<VerifyOtpResult> {
    const now = this.clock();
    const { phoneNumber } = dto;

    // 2. Per-phone limit, counted from the attempts of this phone's sessions of the last hour.
    const hourStart = new Date(now.getTime() - RATE_LIMITS.verifyOtp.phone.windowMs);
    const used = await this.prisma.otpSession.aggregate({
      where: { phoneNumber, purpose: OtpPurpose.RIDER_AUTH, createdAt: { gt: hourStart } },
      _sum: { attempts: true },
    });
    if ((used._sum.attempts ?? 0) >= RATE_LIMITS.verifyOtp.phone.limit) throw new AppException('RATE_LIMITED');

    // 3. The newest rider session is the only one that counts. A driver session for the same phone
    // (purpose DRIVER_AUTH) is never used here, so a driver code cannot log a rider in.
    const session = await this.prisma.otpSession.findFirst({ where: { phoneNumber, purpose: OtpPurpose.RIDER_AUTH }, orderBy: { createdAt: 'desc' } });
    this.assertUsable(session, now);

    // 4. Reserve one attempt with one conditional update, so parallel guesses cannot all pass.
    const reserved = await this.prisma.otpSession.updateMany({
      where: { id: session!.id, attempts: { lt: MAX_OTP_ATTEMPTS }, verifiedAt: null, expiresAt: { gt: now } },
      data: { attempts: { increment: 1 } },
    });
    if (reserved.count === 0) {
      // Another request got there first: answer with what the session looks like now.
      const fresh = await this.prisma.otpSession.findUnique({ where: { id: session!.id } });
      this.assertUsable(fresh, now);
      throw new AppException('OTP_INVALID', { field: 'otp' });
    }

    // 5. Ask the provider. One call, no retry. A provider failure gives the attempt back.
    let matches: boolean;
    try {
      matches = await this.otpProvider.verify(session!.providerSessionId, dto.otp);
    } catch {
      await this.prisma.otpSession.updateMany({
        where: { id: session!.id, attempts: { gt: 0 } },
        data: { attempts: { decrement: 1 } },
      });
      throw new AppException('OTP_PROVIDER_ERROR');
    }
    if (!matches) throw new AppException('OTP_INVALID', { field: 'otp' });

    // 6. Single use: only one request can turn verifiedAt from empty to set.
    const marked = await this.prisma.otpSession.updateMany({
      where: { id: session!.id, verifiedAt: null },
      data: { verifiedAt: now },
    });
    if (marked.count === 0) throw new AppException('OTP_INVALID', { field: 'otp' });

    // 7. Only now, after the caller proved they hold the phone, does the account state matter.
    const rider = await this.prisma.rider.findUnique({ where: { phoneNumber } });
    if (!rider) return this.issueRegistrationToken(session!.id, now);

    if (rider.status !== RiderStatus.ACTIVE) {
      await this.prisma.otpSession.update({ where: { id: session!.id }, data: { consumedAt: now } });
      throw new AppException('ACCOUNT_BANNED');
    }
    return this.login(rider.id, session!.id, dto, now);
  }

  private assertUsable(session: OtpSession | null, now: Date): void {
    if (!session || session.verifiedAt) throw new AppException('OTP_INVALID', { field: 'otp' });
    if (session.expiresAt.getTime() <= now.getTime()) throw new AppException('OTP_EXPIRED', { field: 'otp' });
    if (session.attempts >= MAX_OTP_ATTEMPTS) throw new AppException('OTP_ATTEMPTS_EXCEEDED', { field: 'otp' });
  }

  // A phone with no rider gets a one-time registration token. Only its SHA-256 hash is stored.
  private async issueRegistrationToken(sessionId: string, now: Date): Promise<NewRiderResult> {
    const registrationToken = newOpaqueToken();
    await this.prisma.otpSession.update({
      where: { id: sessionId },
      data: {
        registrationTokenHash: sha256Hex(registrationToken),
        registrationExpiresAt: new Date(now.getTime() + REGISTRATION_TOKEN_TTL_SECONDS * 1000),
      },
    });
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
