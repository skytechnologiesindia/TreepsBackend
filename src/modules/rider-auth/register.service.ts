import { Inject, Injectable } from '@nestjs/common';
import { OtpPurpose, RiderStatus, type OtpSession } from '@prisma/client';
import { CLOCK, type Clock } from '../../common/clock.js';
import { violatedUniqueIndex } from '../../common/database/unique-violation.js';
import { AppException } from '../../common/errors/app.exception.js';
import { newOpaqueToken, sha256Hex } from '../../common/tokens.js';
import { REFRESH_TOKEN_TTL_SECONDS } from '../../config/tokens.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AccessTokenService } from '../../common/jwt/access-token.service.js';
import type { RegisterDto } from './dto/register.dto.js';
import { riderView, type RiderView } from './rider-view.js';
import type { VerifyOtpResult } from './verify-otp.service.js';

export interface RegisterResult {
  rider: RiderView;
  tokens: VerifyOtpResult['tokens'];
}

// A city or state is stored trimmed, or null when nothing is left (the one explicit normalization
// in rider-register.md).
const trimmedOrNull = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

@Injectable()
export class RegisterService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly accessTokens: AccessTokenService,
  ) {}

  // docs/api/rider-register.md, "Order of operations" (steps 3 to 6; the IP guard and validation
  // already ran). No OTP and no provider call happen here.
  async register(dto: RegisterDto): Promise<RegisterResult> {
    const now = this.clock();
    const tokenHash = sha256Hex(dto.registrationToken);

    // 3. The session this token was issued for. One code for every way a token can be bad, so a
    // reply never says which. Only a RIDER_AUTH session can register a rider.
    const session = await this.prisma.otpSession.findUnique({ where: { registrationTokenHash: tokenHash } });
    this.assertTokenUsable(session, now);

    // 4. Pre-checks, before the token is consumed, so a fixable mistake does not burn it.
    if (dto.email !== undefined) {
      const taken = await this.prisma.rider.findUnique({ where: { email: dto.email } });
      if (taken) throw new AppException('EMAIL_IN_USE', { field: 'email' });
    }
    const phoneNumber = session!.phoneNumber;
    if (await this.prisma.rider.findUnique({ where: { phoneNumber } })) throw new AppException('CONFLICT');

    // 5. One transaction: consume the token, create the Rider, the Device and the first refresh
    // token. It is all-or-nothing, so a failure leaves the token usable.
    const refreshToken = newOpaqueToken();
    let rider;
    try {
      rider = await this.prisma.$transaction(async (tx) => {
        // The single-use step: only one request can turn consumedAt from empty to set while the
        // token is still unexpired. A parallel request waits for the first to finish, then matches
        // no row.
        const consumed = await tx.otpSession.updateMany({
          where: { id: session!.id, registrationTokenHash: tokenHash, consumedAt: null, registrationExpiresAt: { gt: now } },
          data: { consumedAt: now },
        });
        if (consumed.count === 0) throw new AppException('REGISTRATION_TOKEN_INVALID', { field: 'registrationToken' });

        const created = await tx.rider.create({
          data: {
            phoneNumber,
            fullName: dto.fullName,
            email: dto.email ?? null,
            registeredCity: trimmedOrNull(dto.registeredCity),
            registeredState: trimmedOrNull(dto.registeredState),
            status: RiderStatus.ACTIVE,
            isPhoneVerified: true,
            isEmailVerified: false,
            isProfileComplete: false,
            lastLoginAt: now, // registration counts as the first login
            createdAt: now,
            updatedAt: now,
          },
        });
        await tx.device.create({
          data: {
            riderId: created.id,
            deviceId: dto.device.deviceId,
            platform: dto.device.platform,
            appVersion: dto.device.appVersion,
            fcmToken: dto.device.fcmToken ?? null,
            lastSeenAt: now,
          },
        });
        await tx.refreshToken.create({
          data: {
            tokenHash: sha256Hex(refreshToken),
            riderId: created.id,
            deviceId: dto.device.deviceId,
            expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_SECONDS * 1000),
            createdAt: now,
          },
        });
        return created;
      });
    } catch (error) {
      // A parallel registration took the email or the phone after the pre-checks. The whole
      // transaction rolled back, including consumedAt, so the token is still usable.
      const index = violatedUniqueIndex(error);
      if (index === 'email') throw new AppException('EMAIL_IN_USE', { field: 'email' });
      if (index === 'phoneNumber') throw new AppException('CONFLICT');
      throw error;
    }

    // 6. Sign the access token (same signer as verify-otp) and reply.
    const access = this.accessTokens.issue({ riderId: rider.id, deviceId: dto.device.deviceId, now });
    return {
      rider: riderView(rider),
      tokens: {
        accessToken: access.token,
        accessTokenExpiresInSeconds: access.expiresInSeconds,
        refreshToken,
        refreshTokenExpiresInSeconds: REFRESH_TOKEN_TTL_SECONDS,
      },
    };
  }

  private assertTokenUsable(session: OtpSession | null, now: Date): void {
    const usable =
      session !== null &&
      session.purpose === OtpPurpose.RIDER_AUTH &&
      session.verifiedAt !== null &&
      session.consumedAt === null &&
      session.registrationExpiresAt !== null &&
      session.registrationExpiresAt.getTime() > now.getTime();
    if (!usable) throw new AppException('REGISTRATION_TOKEN_INVALID', { field: 'registrationToken' });
  }
}
