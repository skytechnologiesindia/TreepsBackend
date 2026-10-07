import { OtpPurpose, type OtpSession } from '@prisma/client';
import { AppException } from '../../common/errors/app.exception.js';
import { MAX_OTP_ATTEMPTS } from '../../config/otp.js';
import { RATE_LIMITS } from '../../config/rate-limits.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { OtpProvider } from './provider/otp-provider.js';

// Anything with an `otpSession` table: the PrismaService itself or a transaction client.
type SessionDb = Pick<PrismaService, 'otpSession'>;

// The code-checking steps shared by rider and driver verify-otp (docs/api/rider-verify-otp.md,
// "Order of operations", steps 2 to 5). Only sessions of the given purpose are ever read, so a rider
// code can never log a driver in and the other way round. In Express terms, one shared middleware
// function both routers call, with the purpose as its argument.
export class OtpCodeChecker {
  constructor(
    private readonly prisma: PrismaService,
    private readonly otpProvider: OtpProvider,
  ) {}

  // Returns the session whose code the provider confirmed. The caller must then call
  // markCodeUsed (in its own transaction, so the code is burned only together with what it unlocks).
  async check(purpose: OtpPurpose, phoneNumber: string, otp: string, now: Date): Promise<OtpSession> {
    // 2. Per-phone limit, counted from the attempts of this phone's sessions of the last hour.
    const hourStart = new Date(now.getTime() - RATE_LIMITS.verifyOtp.phone.windowMs);
    const used = await this.prisma.otpSession.aggregate({
      where: { phoneNumber, purpose, createdAt: { gt: hourStart } },
      _sum: { attempts: true },
    });
    if ((used._sum.attempts ?? 0) >= RATE_LIMITS.verifyOtp.phone.limit) throw new AppException('RATE_LIMITED');

    // 3. The newest session of this purpose is the only one that counts.
    const session = await this.prisma.otpSession.findFirst({ where: { phoneNumber, purpose }, orderBy: { createdAt: 'desc' } });
    assertUsable(session, now);

    // 4. Reserve one attempt with one conditional update, so parallel guesses cannot all pass.
    const reserved = await this.prisma.otpSession.updateMany({
      where: { id: session!.id, attempts: { lt: MAX_OTP_ATTEMPTS }, verifiedAt: null, expiresAt: { gt: now } },
      data: { attempts: { increment: 1 } },
    });
    if (reserved.count === 0) {
      // Another request got there first: answer with what the session looks like now.
      const fresh = await this.prisma.otpSession.findUnique({ where: { id: session!.id } });
      assertUsable(fresh, now);
      throw new AppException('OTP_INVALID', { field: 'otp' });
    }

    // 5. Ask the provider. One call, no retry. A provider failure gives the attempt back.
    let matches: boolean;
    try {
      matches = await this.otpProvider.verify(session!.providerSessionId, otp);
    } catch {
      await this.prisma.otpSession.updateMany({
        where: { id: session!.id, attempts: { gt: 0 } },
        data: { attempts: { decrement: 1 } },
      });
      throw new AppException('OTP_PROVIDER_ERROR');
    }
    if (!matches) throw new AppException('OTP_INVALID', { field: 'otp' });
    return session!;
  }
}

function assertUsable(session: OtpSession | null, now: Date): void {
  if (!session || session.verifiedAt) throw new AppException('OTP_INVALID', { field: 'otp' });
  if (session.expiresAt.getTime() <= now.getTime()) throw new AppException('OTP_EXPIRED', { field: 'otp' });
  if (session.attempts >= MAX_OTP_ATTEMPTS) throw new AppException('OTP_ATTEMPTS_EXCEEDED', { field: 'otp' });
}

// The single-use step: only one request can turn verifiedAt from empty to set. If no row changes,
// another request used the code first. `also` sets more columns in the same write (for example
// consumedAt). Pass a transaction client to make it part of that transaction.
export async function markCodeUsed(db: SessionDb, sessionId: string, now: Date, also: { consumedAt?: Date } = {}): Promise<void> {
  const marked = await db.otpSession.updateMany({
    where: { id: sessionId, verifiedAt: null },
    data: { verifiedAt: now, ...also },
  });
  if (marked.count === 0) throw new AppException('OTP_INVALID', { field: 'otp' });
}
