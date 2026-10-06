import { AppException } from '../../common/errors/app.exception.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { FakeOtpProvider } from './otp/fake-otp.provider.js';
import type { OtpProvider } from './otp/otp-provider.js';
import { RiderAuthService } from './rider-auth.service.js';
import { inMemoryPrisma } from './testing/in-memory-prisma.js';

const PHONE = '+919477172214';
const OTHER_PHONE = '+919477172215';
const SECOND = 1000;
const HOUR = 3_600_000;

function setup(providerOverride?: OtpProvider) {
  let now = new Date('2026-10-05T10:00:00.000Z').getTime();
  const { prisma, rows } = inMemoryPrisma();
  const sends: string[] = [];
  const provider: OtpProvider =
    providerOverride ??
    {
      async send(phone) {
        sends.push(phone);
        return { providerSessionId: `session-${sends.length}` };
      },
      async verify() {
        return false;
      },
    };
  const service = new RiderAuthService(prisma as unknown as PrismaService, provider, () => new Date(now));
  return { service, rows, sends, advance: (ms: number) => (now += ms), now: () => now };
}

const code = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return (error as AppException).code;
  }
  return 'NO_ERROR';
};

describe('RiderAuthService.sendOtp', () => {
  it('creates one OtpSession row (purpose RIDER_AUTH, session id, expiry 5 minutes) and calls the provider once', async () => {
    const { service, rows, sends, now } = setup();
    await service.sendOtp(PHONE);
    expect(sends).toEqual([PHONE]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      phoneNumber: PHONE,
      purpose: 'RIDER_AUTH',
      providerSessionId: 'session-1',
      attempts: 0,
      verifiedAt: null,
      consumedAt: null,
      registrationTokenHash: null,
      registrationExpiresAt: null,
    });
    expect(rows[0].expiresAt.getTime()).toBe(now() + 5 * 60 * SECOND);
    expect(rows[0].createdAt.getTime()).toBe(now());
  });

  it('replies with the two documented numbers and nothing else: no session id, no code', async () => {
    const { service } = setup();
    const result = await service.sendOtp(PHONE);
    expect(result).toEqual({ expiresInSeconds: 300, resendAfterSeconds: 30 });
    expect(JSON.stringify(result)).not.toContain('session');
  });

  it('gives the same reply for every phone', async () => {
    const { service } = setup();
    expect(await service.sendOtp(PHONE)).toEqual(await service.sendOtp(OTHER_PHONE));
  });

  it('never reads the Rider table (the test database throws if it is touched)', async () => {
    const { service, rows } = setup();
    await expect(service.sendOtp(PHONE)).resolves.toBeDefined();
    expect(rows).toHaveLength(1);
    const { prisma } = inMemoryPrisma();
    expect(() => (prisma as { rider: unknown }).rider).toThrow(/never use/); // the guard itself works
  });

  describe('30 second resend cooldown', () => {
    it('blocks a second send inside 30 seconds: RATE_LIMITED, no provider call, no new row', async () => {
      const { service, rows, sends, advance } = setup();
      await service.sendOtp(PHONE);
      advance(29 * SECOND);
      expect(await code(service.sendOtp(PHONE))).toBe('RATE_LIMITED');
      expect(sends).toHaveLength(1);
      expect(rows).toHaveLength(1);
    });

    it('allows the send once 30 seconds have passed', async () => {
      const { service, rows, advance } = setup();
      await service.sendOtp(PHONE);
      advance(30 * SECOND);
      await expect(service.sendOtp(PHONE)).resolves.toBeDefined();
      expect(rows).toHaveLength(2);
    });

    it('does not affect another phone', async () => {
      const { service } = setup();
      await service.sendOtp(PHONE);
      await expect(service.sendOtp(OTHER_PHONE)).resolves.toBeDefined();
    });
  });

  describe('5 sends per phone per hour', () => {
    async function sendFive(ctx: ReturnType<typeof setup>) {
      for (let i = 0; i < 5; i++) {
        await ctx.service.sendOtp(PHONE);
        ctx.advance(31 * SECOND); // past the cooldown each time
      }
    }

    it('allows five and blocks the sixth: RATE_LIMITED, no provider call', async () => {
      const ctx = setup();
      await sendFive(ctx);
      expect(ctx.rows).toHaveLength(5);
      expect(await code(ctx.service.sendOtp(PHONE))).toBe('RATE_LIMITED');
      expect(ctx.sends).toHaveLength(5);
      expect(ctx.rows).toHaveLength(5);
    });

    it('another phone is not blocked', async () => {
      const ctx = setup();
      await sendFive(ctx);
      await expect(ctx.service.sendOtp(OTHER_PHONE)).resolves.toBeDefined();
    });

    it('allows a send again once the oldest has left the hour', async () => {
      const ctx = setup();
      await sendFive(ctx);
      expect(await code(ctx.service.sendOtp(PHONE))).toBe('RATE_LIMITED');
      ctx.advance(HOUR); // every earlier send is now more than an hour old
      await expect(ctx.service.sendOtp(PHONE)).resolves.toBeDefined();
    });
  });

  describe('provider failure', () => {
    it('becomes OTP_PROVIDER_ERROR (503), stores no row, and is called exactly once (no retry)', async () => {
      let calls = 0;
      const failing: OtpProvider = {
        async send() {
          calls += 1;
          throw new Error('SECRET-API-KEY-in-provider-error');
        },
        async verify() {
          return false;
        },
      };
      const { service, rows } = setup(failing);
      let error: AppException | undefined;
      try {
        await service.sendOtp(PHONE);
      } catch (e) {
        error = e as AppException;
      }
      expect(error).toBeInstanceOf(AppException);
      expect(error!.code).toBe('OTP_PROVIDER_ERROR');
      expect(error!.getStatus()).toBe(503);
      expect(JSON.stringify(error!.getResponse())).not.toContain('SECRET');
      expect(calls).toBe(1);
      expect(rows).toHaveLength(0);
    });

    it('a failed send does not use up the cooldown or the hourly count', async () => {
      const failing: OtpProvider = {
        async send() {
          throw new Error('down');
        },
        async verify() {
          return false;
        },
      };
      const { service } = setup(failing);
      for (let i = 0; i < 8; i++) expect(await code(service.sendOtp(PHONE))).toBe('OTP_PROVIDER_ERROR');
    });
  });

  it('a database failure is not turned into a provider error', async () => {
    const { service, rows } = setup();
    const broken = new RiderAuthService(
      { otpSession: { findFirst: async () => null, count: async () => 0, create: async () => { throw new Error('db down'); } } } as unknown as PrismaService,
      new FakeOtpProvider('123456'),
      () => new Date(),
    );
    await expect(broken.sendOtp(PHONE)).rejects.toThrow('db down');
    expect(rows).toHaveLength(0);
    void service;
  });

  it('works with the fake provider: the session id is fake and stays in the row', async () => {
    const { prisma, rows } = inMemoryPrisma();
    const service = new RiderAuthService(prisma as unknown as PrismaService, new FakeOtpProvider('123456'), () => new Date());
    const result = await service.sendOtp(PHONE);
    expect(rows[0].providerSessionId).toMatch(/^fake-session-/);
    expect(JSON.stringify(result)).not.toContain('fake-session');
  });
});
