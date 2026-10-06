import { Inject, Injectable } from '@nestjs/common';
import type { OtpPurpose } from '@prisma/client';
import { CLOCK, type Clock } from '../../common/clock.js';
import { AppException } from '../../common/errors/app.exception.js';
import { OTP_LIFETIME_MS } from '../../config/otp.js';
import { RATE_LIMITS } from '../../config/rate-limits.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { OTP_PROVIDER, type OtpProvider } from './provider/otp-provider.js';

export interface SendOtpResult {
  expiresInSeconds: number;
  resendAfterSeconds: number;
}

// Sends an OTP for one purpose (RIDER_AUTH or DRIVER_AUTH). The purpose comes from the route that
// calls this, never from the request body. docs/api/rider-send-otp.md and driver-send-otp.md,
// "Order of checks". This never reads any account table and gives the same reply for every phone.
// The provider session id is stored here and never returned.
@Injectable()
export class SendOtpService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(OTP_PROVIDER) private readonly otpProvider: OtpProvider,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async sendOtp(purpose: OtpPurpose, phoneNumber: string): Promise<SendOtpResult> {
    const now = this.clock();

    // Per-phone limits, counted from OtpSession rows so they survive a restart and are shared
    // between server instances. They are per phone AND per purpose: a rider session does not count
    // toward a driver's limits, and the other way round. Two simultaneous sends may both pass:
    // accepted (decision 144).
    const cooldownStart = new Date(now.getTime() - RATE_LIMITS.sendOtp.resendCooldownMs);
    const tooSoon = await this.prisma.otpSession.findFirst({
      where: { phoneNumber, purpose, createdAt: { gt: cooldownStart } },
      select: { id: true },
    });
    if (tooSoon) throw new AppException('RATE_LIMITED');

    const hourStart = new Date(now.getTime() - RATE_LIMITS.sendOtp.phone.windowMs);
    const sentLastHour = await this.prisma.otpSession.count({
      where: { phoneNumber, purpose, createdAt: { gt: hourStart } },
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
        purpose,
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
