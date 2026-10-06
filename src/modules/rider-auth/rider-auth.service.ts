import { Inject, Injectable } from '@nestjs/common';
import { OtpPurpose } from '@prisma/client';
import { CLOCK, type Clock } from '../../common/clock.js';
import { AppException } from '../../common/errors/app.exception.js';
import { OTP_LIFETIME_MS } from '../../config/otp.js';
import { RATE_LIMITS } from '../../config/rate-limits.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { OTP_PROVIDER, type OtpProvider } from './otp/otp-provider.js';

export interface SendOtpResult {
  expiresInSeconds: number;
  resendAfterSeconds: number;
}

@Injectable()
export class RiderAuthService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(OTP_PROVIDER) private readonly otpProvider: OtpProvider,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  // docs/api/rider-send-otp.md, "Order of checks". This never reads the Rider table and gives the
  // same reply for every phone. The provider session id is stored here and never returned.
  async sendOtp(phoneNumber: string): Promise<SendOtpResult> {
    const now = this.clock();

    // Per-phone limits, counted from OtpSession rows so they survive a restart and are shared
    // between server instances. Two simultaneous sends may both pass: accepted (decision 144).
    const cooldownStart = new Date(now.getTime() - RATE_LIMITS.sendOtp.resendCooldownMs);
    const tooSoon = await this.prisma.otpSession.findFirst({
      where: { phoneNumber, createdAt: { gt: cooldownStart } },
      select: { id: true },
    });
    if (tooSoon) throw new AppException('RATE_LIMITED');

    const hourStart = new Date(now.getTime() - RATE_LIMITS.sendOtp.phone.windowMs);
    const sentLastHour = await this.prisma.otpSession.count({
      where: { phoneNumber, createdAt: { gt: hourStart } },
    });
    if (sentLastHour >= RATE_LIMITS.sendOtp.phone.limit) throw new AppException('RATE_LIMITED');

    // The provider is called first because the session row needs its session id, and a row is
    // stored only after the provider accepted the request. One call, no retry (a retry can send a
    // second SMS). The provider's error is dropped on purpose: it can carry secrets.
    let providerSessionId: string;
    try {
      ({ providerSessionId } = await this.otpProvider.send(phoneNumber));
    } catch {
      throw new AppException('OTP_PROVIDER_ERROR');
    }

    await this.prisma.otpSession.create({
      data: {
        phoneNumber,
        purpose: OtpPurpose.RIDER_AUTH,
        providerSessionId,
        expiresAt: new Date(now.getTime() + OTP_LIFETIME_MS),
        createdAt: now,
      },
    });

    return {
      expiresInSeconds: OTP_LIFETIME_MS / 1000,
      resendAfterSeconds: RATE_LIMITS.sendOtp.resendCooldownMs / 1000,
    };
  }
}
