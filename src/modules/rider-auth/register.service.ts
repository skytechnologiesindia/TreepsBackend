import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RiderStatus } from '@prisma/client';
import { CLOCK, type Clock } from '../../common/clock.js';
import { violatedUniqueIndex } from '../../common/database/unique-violation.js';
import { AppException } from '../../common/errors/app.exception.js';
import type { ValidatedEnv } from '../../config/env.validation.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { RegisterDto } from './dto/register.dto.js';
import { riderView, type RiderView } from './rider-view.js';

export interface CompleteProfileResult {
  rider: RiderView;
}

@Injectable()
export class RegisterService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly config: ConfigService<ValidatedEnv, true>,
  ) {}

  // docs/api/rider-register.md, "Order of operations" (steps 4 to 6; the guards and validation already
  // ran). The rider is the one in the access token. No OTP, no provider call, no new tokens.
  async completeProfile(riderId: string, dto: RegisterDto): Promise<CompleteProfileResult> {
    const now = this.clock();

    // 4. The caller. No row at all is a token for a rider that no longer exists.
    const current = await this.prisma.rider.findUnique({ where: { id: riderId } });
    if (!current) throw new AppException('UNAUTHORIZED');

    // Completing the profile (PROFILE_PENDING -> ACTIVE) needs the name. The DTO cannot know the state,
    // so it is checked here, with the same INVALID_INPUT shape the validation pipe gives (field name
    // and reason only). Gender is never required (decision 183). An ACTIVE rider calling again may
    // send any subset.
    if (current.status === RiderStatus.PROFILE_PENDING && dto.fullName === undefined) {
      throw new AppException('INVALID_INPUT', { field: 'fullName', details: [{ field: 'fullName', reason: 'REQUIRED' }] });
    }

    // 5. Pre-check, so a fixable mistake gets a clear answer before the write. The rider's own email
    // is not a clash (a second call may send the same one again). The match is exact: the DTO has
    // already lowercased the address, so A@x.com is looked up as a@x.com.
    const emailChanged = dto.email !== undefined && dto.email !== current.email;
    if (emailChanged) {
      const holder = await this.prisma.rider.findUnique({ where: { email: dto.email } });
      if (holder && holder.id !== riderId) throw new AppException('EMAIL_IN_USE', { field: 'email' });
    }

    // Every optional field: sent means saved, omitted (or blank, or null) keeps the stored value.
    // Clearing a field is not supported yet.
    const values = {
      ...(dto.fullName !== undefined ? { fullName: dto.fullName } : {}),
      ...(dto.gender !== undefined ? { gender: dto.gender } : {}),
      ...(emailChanged ? { email: dto.email, isEmailVerified: false } : {}),
      ...(dto.registeredCity ? { registeredCity: dto.registeredCity } : {}),
      ...(dto.registeredState ? { registeredState: dto.registeredState } : {}),
      ...(dto.registeredAddress !== undefined ? { registeredAddress: dto.registeredAddress } : {}),
      status: RiderStatus.ACTIVE,
      isProfileComplete: true,
      updatedAt: now,
    };

    // 6. Conditional updates (the where clause is the guard). The first one matches only a
    // PROFILE_PENDING rider and also stamps the terms proof, once: termsAcceptedAt and termsVersion
    // are never part of the second one, so they are never overwritten, and an already ACTIVE rider
    // (including every rider who completed the profile before these columns existed) keeps them as
    // they are. The second matches an ACTIVE rider calling again. A banned or deleted rider matches
    // neither.
    let updated;
    try {
      updated = await this.prisma.rider.updateMany({
        where: { id: riderId, status: RiderStatus.PROFILE_PENDING },
        data: { ...values, termsAcceptedAt: now, termsVersion: this.config.get('TERMS_VERSION', { infer: true }) },
      });
      if (updated.count === 0) {
        updated = await this.prisma.rider.updateMany({ where: { id: riderId, status: RiderStatus.ACTIVE }, data: values });
      }
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
