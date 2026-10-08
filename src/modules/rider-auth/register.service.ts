import { Inject, Injectable } from '@nestjs/common';
import { RiderStatus } from '@prisma/client';
import { CLOCK, type Clock } from '../../common/clock.js';
import { violatedUniqueIndex } from '../../common/database/unique-violation.js';
import { AppException } from '../../common/errors/app.exception.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { RegisterDto } from './dto/register.dto.js';
import { riderView, type RiderView } from './rider-view.js';

export interface CompleteProfileResult {
  rider: RiderView;
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
  ) {}

  // docs/api/rider-register.md, "Order of operations" (steps 4 to 6; the guards and validation already
  // ran). The rider is the one in the access token. No OTP, no provider call, no new tokens.
  async completeProfile(riderId: string, dto: RegisterDto): Promise<CompleteProfileResult> {
    const now = this.clock();

    // 4. The caller. No row at all is a token for a rider that no longer exists.
    const current = await this.prisma.rider.findUnique({ where: { id: riderId } });
    if (!current) throw new AppException('UNAUTHORIZED');

    // 5. Pre-check, so a fixable mistake gets a clear answer before the write. The rider's own email
    // is not a clash (a second call may send the same one again). The match is exact: the API only
    // accepts lowercase emails, so A@x.com never gets this far (docs: rider-register.md, email rule).
    const emailChanged = dto.email !== undefined && dto.email !== current.email;
    if (emailChanged) {
      const holder = await this.prisma.rider.findUnique({ where: { email: dto.email } });
      if (holder && holder.id !== riderId) throw new AppException('EMAIL_IN_USE', { field: 'email' });
    }

    const city = trimmedOrNull(dto.registeredCity);
    const state = trimmedOrNull(dto.registeredState);

    // 6. One conditional update. PROFILE_PENDING becomes ACTIVE; an ACTIVE rider calling again just
    // saves the new values. A banned or deleted rider matches no row. An omitted email stays as it
    // was; a different one is unproven again, so isEmailVerified goes back to false.
    let updated;
    try {
      updated = await this.prisma.rider.updateMany({
        where: { id: riderId, status: { in: [RiderStatus.PROFILE_PENDING, RiderStatus.ACTIVE] } },
        data: {
          fullName: dto.fullName,
          ...(emailChanged ? { email: dto.email, isEmailVerified: false } : {}),
          // Like email: sent means saved, omitted keeps the stored value. A null or blank value is
          // treated as not sent (clearing a field is not supported yet).
          ...(city !== null ? { registeredCity: city } : {}),
          ...(state !== null ? { registeredState: state } : {}),
          status: RiderStatus.ACTIVE,
          isProfileComplete: true,
          updatedAt: now,
        },
      });
    } catch (error) {
      // Another rider took the email after the pre-check (the unique index decides the race).
      if (violatedUniqueIndex(error) === 'email') throw new AppException('EMAIL_IN_USE', { field: 'email' });
      throw error;
    }
    if (updated.count === 0) throw new AppException('ACCOUNT_BANNED'); // SUSPENDED, BLOCKED or DELETED

    // 7. Read the rider back and reply.
    const rider = await this.prisma.rider.findUnique({ where: { id: riderId } });
    if (!rider) throw new AppException('UNAUTHORIZED');
    return { rider: riderView(rider) };
  }
}
