import { AppException } from '../../common/errors/app.exception.js';
import { verifyHs256Jwt } from '../../common/jwt/hs256-jwt.js';
import { newOpaqueToken, sha256Hex } from '../../common/tokens.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { AccessTokenService } from '../../common/jwt/access-token.service.js';
import type { RegisterDto } from './dto/register.dto.js';
import { RegisterService } from './register.service.js';
import { InMemoryAuthDb } from './testing/in-memory-auth-db.js';

const PHONE = '+919477172214';
const SECRET = 'placeholder-jwt-secret-0123456789abcdef';
const T0 = new Date('2026-10-05T10:00:00.000Z').getTime();
const SECOND = 1000;
const MINUTE = 60 * SECOND;

function setup() {
  let now = T0;
  const db = new InMemoryAuthDb();
  const service = new RegisterService(db as unknown as PrismaService, () => new Date(now), new AccessTokenService(SECRET));
  return {
    db,
    service,
    advance: (ms: number) => (now += ms),
    // A session that verify-otp has finished for an unknown phone: the code is used, a registration
    // token was issued (only its hash is stored) and it is valid for 10 more minutes.
    session(overrides: Record<string, unknown> = {}) {
      const token = newOpaqueToken();
      const row = db.addSession({
        phoneNumber: PHONE,
        attempts: 1,
        createdAt: new Date(now - MINUTE),
        verifiedAt: new Date(now - 10 * SECOND),
        registrationTokenHash: sha256Hex(token),
        registrationExpiresAt: new Date(now - 10 * SECOND + 10 * MINUTE),
        ...overrides,
      });
      return { token, row };
    },
  };
}
type Ctx = ReturnType<typeof setup>;

const dto = (token: string, overrides: Partial<RegisterDto> = {}, device: Partial<RegisterDto['device']> = {}): RegisterDto => ({
  registrationToken: token,
  fullName: 'Asha Verma',
  device: { deviceId: 'device-1', platform: 'ANDROID', appVersion: '1.4.2', ...device },
  ...overrides,
});

async function errorOf(promise: Promise<unknown>): Promise<AppException | undefined> {
  try {
    await promise;
  } catch (error) {
    return error as AppException;
  }
  return undefined;
}
const shape = (e: AppException | undefined) => e && { code: e.code, status: e.getStatus(), field: e.field, response: e.getResponse() };

const nothingCreated = (ctx: Ctx) => {
  expect(ctx.db.tables.rider).toHaveLength(0);
  expect(ctx.db.tables.device).toHaveLength(0);
  expect(ctx.db.tables.refreshToken).toHaveLength(0);
};

describe('RegisterService: happy path', () => {
  it('creates the rider, device and refresh token, and consumes the session', async () => {
    const ctx = setup();
    const { token } = ctx.session();
    const result = await ctx.service.register(dto(token, { email: 'asha@example.com', registeredCity: 'Ranchi', registeredState: 'Jharkhand' }));

    expect(result.rider).toMatchObject({
      fullName: 'Asha Verma',
      phoneNumber: PHONE, // from the verified session, never from the client
      email: 'asha@example.com',
      registeredCity: 'Ranchi',
      registeredState: 'Jharkhand',
      status: 'ACTIVE',
      isPhoneVerified: true,
      isEmailVerified: false,
      isProfileComplete: false,
      createdAt: '2026-10-05T10:00:00.000Z',
    });
    expect(ctx.db.tables.rider).toHaveLength(1);
    expect(ctx.db.tables.rider[0].lastLoginAt.getTime()).toBe(T0); // registration is the first login
    expect(ctx.db.tables.device).toHaveLength(1);
    expect(ctx.db.tables.device[0]).toMatchObject({ riderId: result.rider.id, deviceId: 'device-1', platform: 'ANDROID', appVersion: '1.4.2', fcmToken: null });
    expect(ctx.db.tables.refreshToken).toHaveLength(1);
    const stored = ctx.db.tables.refreshToken[0];
    expect(stored.tokenHash).toBe(sha256Hex(result.tokens.refreshToken));
    expect(stored.tokenHash).not.toBe(result.tokens.refreshToken);
    expect(JSON.stringify(ctx.db.tables.refreshToken)).not.toContain(result.tokens.refreshToken);
    expect(stored.expiresAt.getTime()).toBe(T0 + 2_592_000 * SECOND);
    expect(stored.revokedAt).toBeNull();
    expect(ctx.db.tables.otpSession[0].consumedAt.getTime()).toBe(T0);
    expect(result.tokens.refreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.tokens.accessTokenExpiresInSeconds).toBe(900);
    expect(result.tokens.refreshTokenExpiresInSeconds).toBe(2_592_000);
  });

  it('signs the access token with the rider id and the device id', async () => {
    const ctx = setup();
    const { token } = ctx.session();
    const result = await ctx.service.register(dto(token));
    const claims = verifyHs256Jwt(result.tokens.accessToken, SECRET, T0 / 1000);
    expect(claims).toEqual({ iss: 'treeps', sub: result.rider.id, role: 'RIDER', deviceId: 'device-1', iat: T0 / 1000, exp: T0 / 1000 + 900 });
  });

  it('stores no email when none is sent, and keeps fcmToken when it is sent', async () => {
    const ctx = setup();
    const { token } = ctx.session();
    const result = await ctx.service.register(dto(token, {}, { fcmToken: 'push-token-1' }));
    expect(result.rider.email).toBeNull();
    expect(ctx.db.tables.device[0].fcmToken).toBe('push-token-1');
  });

  it('never returns deletedAt, lastLoginAt, hashes, the provider session id or attempts', async () => {
    const ctx = setup();
    const { token } = ctx.session({ providerSessionId: 'SECRET-SESSION' });
    const text = JSON.stringify(await ctx.service.register(dto(token)));
    for (const forbidden of ['SECRET-SESSION', 'attempts', 'tokenHash', 'deletedAt', 'lastLoginAt', 'registrationTokenHash', 'verifiedAt', 'consumedAt']) {
      expect(text).not.toContain(forbidden);
    }
    expect(text).not.toContain(sha256Hex(token));
  });

  it('does not consume a different phone\'s session', async () => {
    const ctx = setup();
    const { token } = ctx.session();
    const other = ctx.session({ phoneNumber: '+919477172215' });
    await ctx.service.register(dto(token));
    expect(other.row.consumedAt).toBeNull();
  });
});

describe('RegisterService: city and state (the one explicit normalization)', () => {
  it.each([
    ['omitted', undefined, null],
    ['null', null, null],
    ['padded with spaces', '  Ranchi ', 'Ranchi'],
    ['only whitespace', '   ', null],
  ])('%s is stored as %s', async (_name, sent, stored) => {
    const ctx = setup();
    const { token } = ctx.session();
    const result = await ctx.service.register(dto(token, { registeredCity: sent, registeredState: sent }));
    expect(result.rider.registeredCity).toBe(stored);
    expect(result.rider.registeredState).toBe(stored);
  });
});

describe('RegisterService: the registration token', () => {
  const bad: Array<[string, (ctx: Ctx) => string]> = [
    ['an unknown token', (ctx) => (ctx.session(), newOpaqueToken())],
    ['an expired token', (ctx) => ctx.session({ registrationExpiresAt: new Date(T0 - 1) }).token],
    ['a token that expires this very millisecond', (ctx) => ctx.session({ registrationExpiresAt: new Date(T0) }).token],
    ['an already used token', (ctx) => ctx.session({ consumedAt: new Date(T0 - SECOND) }).token],
    ['a session whose code was never verified', (ctx) => ctx.session({ verifiedAt: null }).token],
    ['a driver session', (ctx) => ctx.session({ purpose: 'DRIVER_AUTH' }).token],
  ];

  it.each(bad)('%s is REGISTRATION_TOKEN_INVALID (422, field registrationToken), and creates nothing', async (_name, make) => {
    const ctx = setup();
    const error = await errorOf(ctx.service.register(dto(make(ctx))));
    expect(error?.code).toBe('REGISTRATION_TOKEN_INVALID');
    expect(error?.getStatus()).toBe(422);
    expect(error?.field).toBe('registrationToken');
    nothingCreated(ctx);
  });

  it('gives an identical reply for every way a token can be bad', async () => {
    const shapes = [];
    for (const [, make] of bad) {
      const ctx = setup();
      shapes.push(shape(await errorOf(ctx.service.register(dto(make(ctx))))));
    }
    for (const s of shapes) expect(s).toEqual(shapes[0]);
  });

  it('works one millisecond before it expires', async () => {
    const ctx = setup();
    const { token } = ctx.session({ registrationExpiresAt: new Date(T0 + 1) });
    expect((await ctx.service.register(dto(token))).rider.phoneNumber).toBe(PHONE);
  });

  it('expires 10 minutes after verify-otp issued it', async () => {
    const ctx = setup();
    const { token } = ctx.session(); // issued 10 seconds ago, so it has 9 minutes 50 seconds left
    ctx.advance(9 * MINUTE + 50 * SECOND);
    expect((await errorOf(ctx.service.register(dto(token))))?.code).toBe('REGISTRATION_TOKEN_INVALID');
  });

  it('a second register with the same token is REGISTRATION_TOKEN_INVALID and creates nothing more', async () => {
    const ctx = setup();
    const { token } = ctx.session();
    await ctx.service.register(dto(token));
    const again = await errorOf(ctx.service.register(dto(token, { fullName: 'Someone Else' }, { deviceId: 'device-2' })));
    expect(again?.code).toBe('REGISTRATION_TOKEN_INVALID');
    expect(ctx.db.tables.rider).toHaveLength(1);
    expect(ctx.db.tables.device).toHaveLength(1);
    expect(ctx.db.tables.refreshToken).toHaveLength(1);
  });
});

describe('RegisterService: pre-checks do not burn the token', () => {
  it('EMAIL_IN_USE (409, field email): the token is not consumed and works with a different email', async () => {
    const ctx = setup();
    ctx.db.addRider({ phoneNumber: '+919477172299', email: 'taken@example.com' });
    const { token } = ctx.session();
    const error = await errorOf(ctx.service.register(dto(token, { email: 'taken@example.com' })));
    expect(error?.code).toBe('EMAIL_IN_USE');
    expect(error?.getStatus()).toBe(409);
    expect(error?.field).toBe('email');
    expect(ctx.db.tables.rider).toHaveLength(1); // only the one that was already there
    expect(ctx.db.tables.device).toHaveLength(0);
    expect(ctx.db.tables.otpSession[0].consumedAt).toBeNull();

    const retry = await ctx.service.register(dto(token, { email: 'free@example.com' }));
    expect(retry.rider.email).toBe('free@example.com');
  });

  it('CONFLICT (409): a rider already owns the session\'s phone, and the token is not consumed', async () => {
    const ctx = setup();
    ctx.db.addRider({ phoneNumber: PHONE });
    const { token } = ctx.session();
    const error = await errorOf(ctx.service.register(dto(token)));
    expect(error?.code).toBe('CONFLICT');
    expect(error?.getStatus()).toBe(409);
    expect(error?.field).toBeNull();
    expect(ctx.db.tables.device).toHaveLength(0);
    expect(ctx.db.tables.otpSession[0].consumedAt).toBeNull();
  });
});

describe('RegisterService: a failure part-way leaves nothing half-created', () => {
  // The in-memory transaction rolls every table back when the callback throws, like Postgres. After a
  // rollback the table arrays are new objects, so read them through ctx.db, not through old row references.
  it.each(['otpSession.updateMany', 'rider.create', 'device.create', 'refreshToken.create'])(
    'a database failure at %s: no rider, device, refresh token or consumedAt remains, and the token still works',
    async (failing) => {
      const ctx = setup();
      const { token } = ctx.session();
      ctx.db.failOn = failing;
      await expect(ctx.service.register(dto(token))).rejects.toThrow('injected database failure');
      nothingCreated(ctx);
      expect(ctx.db.tables.otpSession[0].consumedAt).toBeNull();

      ctx.db.failOn = null;
      const retry = await ctx.service.register(dto(token));
      expect(retry.rider.phoneNumber).toBe(PHONE);
      expect(ctx.db.tables.rider).toHaveLength(1);
      expect(ctx.db.tables.refreshToken).toHaveLength(1);
    },
  );

  // These two simulate a parallel registration winning between the pre-checks and the insert: the
  // unique index fires inside the transaction (the in-memory database throws what Prisma 7 throws).
  function otherRegistrationWins(ctx: Ctx, rider: Record<string, unknown>) {
    let done = false;
    ctx.db.failWhen = (operation) => {
      if (operation === 'otpSession.updateMany' && !done) {
        done = true;
        ctx.db.addRider(rider);
      }
      return false;
    };
  }

  it('the email taken in parallel becomes EMAIL_IN_USE, and the token stays usable', async () => {
    const ctx = setup();
    const { token } = ctx.session();
    otherRegistrationWins(ctx, { phoneNumber: '+919477172299', email: 'race@example.com' });
    const error = await errorOf(ctx.service.register(dto(token, { email: 'race@example.com' })));
    expect(error?.code).toBe('EMAIL_IN_USE');
    expect(error?.field).toBe('email');
    expect(ctx.db.tables.otpSession[0].consumedAt).toBeNull();
    expect(ctx.db.tables.device).toHaveLength(0);
  });

  it('the phone taken in parallel becomes CONFLICT, and the token stays usable', async () => {
    const ctx = setup();
    const { token } = ctx.session();
    otherRegistrationWins(ctx, { phoneNumber: PHONE, email: null });
    const error = await errorOf(ctx.service.register(dto(token)));
    expect(error?.code).toBe('CONFLICT');
    expect(error?.getStatus()).toBe(409);
    expect(ctx.db.tables.otpSession[0].consumedAt).toBeNull();
    expect(ctx.db.tables.device).toHaveLength(0);
  });

  it('a unique violation on some other index is not turned into a 409', async () => {
    const ctx = setup();
    const { token } = ctx.session();
    ctx.db.failOn = 'refreshToken.create';
    ctx.db.failError = Object.assign(new Error('x'), { code: 'P2002', meta: { driverAdapterError: { cause: { constraint: { index: 'RefreshToken_tokenHash_key' } } } } });
    await expect(ctx.service.register(dto(token))).rejects.toThrow('x');
  });
});
