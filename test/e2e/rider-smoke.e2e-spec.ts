import { execSync } from 'node:child_process';
import type { INestApplication, Type } from '@nestjs/common';
import { config as loadDotenv } from 'dotenv';
import pg from 'pg';
import { AccessTokenService } from '../../src/common/jwt/access-token.service.js';
import { signHs256Jwt } from '../../src/common/jwt/hs256-jwt.js';

// Real-Postgres end-to-end smoke test of the rider (and driver) auth flow over real HTTP.
// No in-memory database, no mocks: the real AppModule with the production wiring (setupApp), a
// throwaway database, real fetch. How to run and what it does: docs/runbooks/e2e-rider-smoke.md.
//
// Safety: the database name is the constant below and is never read from the environment, it is
// not treeps_db, and only the host, port, user and password come from DATABASE_URL in .env. The
// database is created at the start and dropped at the end.
const SCRATCH_DB = 'treeps_scratch_e2e';
const FAKE_CODE = '424242';
const WRONG_CODE = '000000';
const SECRET = 'e2e-test-jwt-secret-0123456789abcdefghij';
const OTHER_SECRET = 'another-e2e-secret-0123456789abcdefghij';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IST = /^\d{2}-\d{2}-\d{4} \d{2}:\d{2}:\d{2}$/;
const device = { deviceId: 'e2e-device-1', platform: 'ANDROID', appVersion: '1.4.2' };

interface Reply {
  status: number;
  body: any;
  requestId: string | null;
}
interface Row {
  n: number;
  name: string;
  expected: string;
  actual: string;
  pass: boolean;
}

const rows: Row[] = [];
const allReplies: Reply[] = [];
let phoneSeq = 0;
const newPhone = () => `+919${String(Date.now() % 1_000_000).padStart(6, '0')}${String(++phoneSeq).padStart(3, '0')}`;

function urlFor(database: string): string {
  loadDotenv({ quiet: true });
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is missing (needed for host and credentials only)');
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = `/${database}`;
  return url.toString();
}

const label = (r: Reply) => `${r.status} ${r.body?.success ? 'OK' : (r.body?.error?.code ?? '?')}`;

describe.skipIf(process.env.RUN_E2E_PG !== '1')(`rider flow smoke, real Postgres (${SCRATCH_DB}), real HTTP`, () => {
  let pool: pg.Pool;
  let app: INestApplication | undefined;
  let baseUrl = '';
  let AppModule: Type<unknown>;
  let setupApp: (app: INestApplication) => void;
  let assertRouteInputs: (app: INestApplication) => void;
  const apps: INestApplication[] = [];

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: urlFor('postgres') });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  // A fresh app means fresh in-memory IP rate counters (they live in the process).
  async function startApp() {
    if (app) await app.close();
    const { NestFactory } = await import('@nestjs/core');
    app = await NestFactory.create(AppModule, { logger: ['error'] });
    setupApp(app);
    assertRouteInputs(app);
    await app.listen(0, '127.0.0.1');
    apps.push(app);
    baseUrl = `${(await app.getUrl()).replace('[::1]', '127.0.0.1')}/v1`;
  }

  async function call(path: string, payload: unknown, token?: string): Promise<Reply> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token !== undefined) headers.authorization = `Bearer ${token}`;
    const res = await fetch(`${baseUrl}${path}`, { method: 'POST', headers, body: JSON.stringify(payload) });
    const reply = { status: res.status, body: await res.json(), requestId: res.headers.get('x-request-id') };
    allReplies.push(reply);
    return reply;
  }

  // Makes a phone's earlier OTP sessions look 31 s old, so the 30 s resend cooldown (counted from
  // OtpSession.createdAt in the database) has passed without waiting. Real rows, real queries.
  const ageSessions = (phone: string) => pool.query(`UPDATE "OtpSession" SET "createdAt" = now() - interval '31 seconds' WHERE "phoneNumber" = $1`, [phone]);

  const send = (phone: string, route = 'rider') => call(`/${route}/auth/send-otp`, { phoneNumber: phone });
  const verify = (phone: string, otp = FAKE_CODE, route = 'rider') => call(`/${route}/auth/verify-otp`, { phoneNumber: phone, otp, device });
  const register = (payload: unknown, token?: string) => call('/rider/auth/register', payload, token);

  // Sends, verifies, and returns the verify reply (a new rider in PROFILE_PENDING).
  async function newRider(phone = newPhone()) {
    const sent = await send(phone);
    if (sent.status !== 200) throw new Error(`setup: send-otp gave ${label(sent)}`);
    const verified = await verify(phone);
    if (verified.status !== 200) throw new Error(`setup: verify-otp gave ${label(verified)}`);
    return { phone, id: verified.body.data.rider.id as string, token: verified.body.data.tokens.accessToken as string, reply: verified };
  }
  // Same phone again: age the session, send, verify.
  async function loginAgain(phone: string) {
    await ageSessions(phone);
    const sent = await send(phone);
    if (sent.status !== 200) throw new Error(`setup: send-otp gave ${label(sent)}`);
    return verify(phone);
  }

  // Records one table row. A thrown error is a FAIL with the error as the actual value, never a skip.
  async function check(n: number, name: string, expected: string, fn: () => Promise<{ actual: string; pass: boolean }>) {
    try {
      const { actual, pass } = await fn();
      rows.push({ n, name, expected, actual, pass });
    } catch (error) {
      rows.push({ n, name, expected, actual: `ERROR ${(error as Error).message}`, pass: false });
    }
  }
  const is = (r: Reply, status: number, code?: string, extra = true) => ({
    actual: label(r),
    pass: r.status === status && (code === undefined ? r.body?.success === true : r.body?.error?.code === code) && extra,
  });

  beforeAll(async () => {
    // 1. A throwaway database. 2. The real migrations, applied with `prisma migrate deploy`.
    await admin(async (c) => {
      await c.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB}" WITH (FORCE)`);
      await c.query(`CREATE DATABASE "${SCRATCH_DB}"`);
    });
    const scratchUrl = urlFor(SCRATCH_DB);
    if (new URL(scratchUrl).pathname !== `/${SCRATCH_DB}`) throw new Error('Refusing to continue: not the scratch database');
    execSync('npx prisma migrate deploy', { env: { ...process.env, DATABASE_URL: scratchUrl }, stdio: 'pipe' });
    pool = new pg.Pool({ connectionString: scratchUrl });

    // 3. The app's environment, set before AppModule is imported (it validates the environment when
    // the module is defined). DATABASE_URL is the scratch database; .env cannot override it.
    vi.stubEnv('DATABASE_URL', scratchUrl);
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('OTP_PROVIDER', 'fake');
    vi.stubEnv('ALLOW_FAKE_OTP', 'true');
    vi.stubEnv('FAKE_OTP_CODE', FAKE_CODE);
    vi.stubEnv('JWT_ACCESS_SECRET', SECRET);
    ({ AppModule } = (await import('../../src/app.module.js')) as { AppModule: Type<unknown> });
    ({ setupApp } = await import('../../src/common/setup-app.js'));
    ({ assertRouteInputs } = await import('../../src/common/validation/route-inputs.js'));
    const current = await pool.query('SELECT current_database() AS name');
    if (current.rows[0].name !== SCRATCH_DB) throw new Error('Refusing to continue: not the scratch database');
  }, 180_000);

  afterAll(async () => {
    for (const a of apps) await a.close().catch(() => undefined);
    await pool?.end().catch(() => undefined);
    await admin((c) => c.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB}" WITH (FORCE)`));
    const left = await admin((c) => c.query('SELECT 1 FROM pg_database WHERE datname = $1', [SCRATCH_DB]));
    vi.unstubAllEnvs();

    const pad = (s: string, w: number) => (s.length > w ? `${s.slice(0, w - 1)}…` : s.padEnd(w));
    const lines = [
      '',
      `${pad('#', 3)} ${pad('Case', 46)} ${pad('Expected', 30)} ${pad('Actual', 42)} Result`,
      '-'.repeat(135),
      ...rows.sort((a, b) => a.n - b.n).map((r) => `${pad(String(r.n), 3)} ${pad(r.name, 46)} ${pad(r.expected, 30)} ${pad(r.actual, 42)} ${r.pass ? 'PASS' : 'FAIL'}`),
      '-'.repeat(135),
      `${rows.filter((r) => r.pass).length} PASS, ${rows.filter((r) => !r.pass).length} FAIL of ${rows.length}. Scratch database ${SCRATCH_DB} ${left.rowCount === 0 ? 'dropped' : 'STILL EXISTS'}.`,
      '',
    ];
    process.stdout.write(lines.join('\n'));
    expect(left.rowCount).toBe(0);
  }, 120_000);

  // ---------------------------------------------------------------- Flow
  describe('flow', () => {
    const s: { phone: string; id: string; token: string; email: string } = { phone: '', id: '', token: '', email: 'asha@example.com' };
    beforeAll(startApp);

    it('cases 1 to 9', async () => {
      s.phone = newPhone();
      await check(1, 'send-otp new phone', '200', async () => is(await send(s.phone), 200));

      await check(2, 'verify-otp wrong code', '422 OTP_INVALID', async () => is(await verify(s.phone, WRONG_CODE), 422, 'OTP_INVALID'));

      await check(3, 'verify-otp right code (new rider)', '200 new, PROFILE_PENDING, tokens, Ist', async () => {
        const r = await verify(s.phone);
        const d = r.body?.data;
        s.id = d?.rider?.id;
        s.token = d?.tokens?.accessToken;
        const pass =
          r.status === 200 && d.isNewRider === true && d.rider.status === 'PROFILE_PENDING' && d.rider.isProfileComplete === false &&
          typeof d.tokens.accessToken === 'string' && typeof d.tokens.refreshToken === 'string' &&
          typeof d.rider.createdAt === 'string' && IST.test(d.rider.createdAtIst);
        return { actual: `${label(r)} new=${d?.isNewRider} ${d?.rider?.status} complete=${d?.rider?.isProfileComplete} ist=${d?.rider?.createdAtIst}`, pass };
      });

      await check(4, 'verify-otp replay of the same code', '422 OTP_INVALID', async () => is(await verify(s.phone), 422, 'OTP_INVALID'));

      await check(5, 'register with access token', '200 ACTIVE complete, email unverified', async () => {
        const r = await register({ fullName: 'Asha Verma', email: s.email, registeredCity: 'Ranchi', registeredState: 'Jharkhand' }, s.token);
        const rider = r.body?.data?.rider;
        return { actual: `${label(r)} ${rider?.status} complete=${rider?.isProfileComplete} emailVerified=${rider?.isEmailVerified}`, pass: r.status === 200 && rider.status === 'ACTIVE' && rider.isProfileComplete === true && rider.isEmailVerified === false && rider.email === s.email };
      });

      await check(6, 'register again with only fullName', 'name changed; email, city, state kept', async () => {
        const r = await register({ fullName: 'Asha Kumari' }, s.token);
        const rider = r.body?.data?.rider;
        return { actual: `${label(r)} ${rider?.fullName} ${rider?.email} ${rider?.registeredCity}/${rider?.registeredState}`, pass: r.status === 200 && rider.fullName === 'Asha Kumari' && rider.email === s.email && rider.registeredCity === 'Ranchi' && rider.registeredState === 'Jharkhand' };
      });

      await check(7, 'register again with a different email', 'email changed, isEmailVerified false', async () => {
        await pool.query(`UPDATE "Rider" SET "isEmailVerified" = true WHERE id = $1`, [s.id]); // so the reset is visible
        const r = await register({ fullName: 'Asha Kumari', email: 'asha.new@example.com' }, s.token);
        const rider = r.body?.data?.rider;
        return { actual: `${label(r)} ${rider?.email} emailVerified=${rider?.isEmailVerified}`, pass: r.status === 200 && rider.email === 'asha.new@example.com' && rider.isEmailVerified === false };
      });

      await check(8, 'same phone logs in again', '200 isNewRider false, complete, same id', async () => {
        const r = await loginAgain(s.phone);
        const d = r.body?.data;
        return { actual: `${label(r)} new=${d?.isNewRider} complete=${d?.rider?.isProfileComplete} sameId=${d?.rider?.id === s.id}`, pass: r.status === 200 && d.isNewRider === false && d.rider.isProfileComplete === true && d.rider.id === s.id };
      });

      await check(9, 'resumed mid-registration (no register)', 'same id, PROFILE_PENDING, no CONFLICT', async () => {
        const first = await newRider();
        const r = await loginAgain(first.phone);
        const d = r.body?.data;
        return { actual: `${label(r)} new=${d?.isNewRider} ${d?.rider?.status} sameId=${d?.rider?.id === first.id}`, pass: r.status === 200 && d.isNewRider === false && d.rider.id === first.id && d.rider.status === 'PROFILE_PENDING' };
      });
    });
  });

  // ---------------------------------------------------------------- Auth
  describe('auth', () => {
    beforeAll(startApp);

    it('cases 10 to 14', async () => {
      const rider = await newRider();
      const body = { fullName: 'Asha Verma' };
      const iat = Math.floor(Date.now() / 1000) - 3600;

      await check(10, 'register, no Authorization header', '401 UNAUTHORIZED', async () => is(await register(body), 401, 'UNAUTHORIZED'));
      await check(11, 'register, garbage token', '401 UNAUTHORIZED', async () => is(await register(body, 'not.a.token'), 401, 'UNAUTHORIZED'));
      await check(12, 'register, expired token (right secret)', '401 UNAUTHORIZED', async () => {
        const expired = signHs256Jwt({ iss: 'treeps', sub: rider.id, role: 'RIDER', deviceId: device.deviceId, iat, exp: iat + 900 }, SECRET);
        return is(await register(body, expired), 401, 'UNAUTHORIZED');
      });
      await check(13, 'register, token signed with another secret', '401 UNAUTHORIZED', async () => {
        const forged = new AccessTokenService(OTHER_SECRET).issue({ riderId: rider.id, deviceId: device.deviceId, now: new Date() }).token;
        return is(await register(body, forged), 401, 'UNAUTHORIZED');
      });
      await check(14, 'DRIVER token on the rider register route', '403 FORBIDDEN', async () => {
        const phone = newPhone();
        await send(phone, 'driver');
        const driver = await verify(phone, FAKE_CODE, 'driver');
        const r = await register(body, driver.body?.data?.tokens?.accessToken);
        return is(r, 403, 'FORBIDDEN', driver.status === 200);
      });
    });
  });

  // ---------------------------------------------------------------- Validation
  describe('validation', () => {
    beforeAll(startApp);

    it('cases 15 to 18', async () => {
      const rider = await newRider();
      const detail = (r: Reply) => r.body?.error?.details?.map((d: any) => `${d.field}:${d.reason}`).join(',');

      await check(15, 'register, empty fullName', '400 INVALID_INPUT', async () => {
        const r = await register({ fullName: '' }, rider.token);
        return { actual: `${label(r)} ${detail(r)}`, pass: r.status === 400 && r.body.error.code === 'INVALID_INPUT' };
      });
      await check(16, 'register, bad email', '400 INVALID_INPUT', async () => {
        const r = await register({ fullName: 'Asha Verma', email: 'not-an-email' }, rider.token);
        return { actual: `${label(r)} ${detail(r)}`, pass: r.status === 400 && r.body.error.code === 'INVALID_INPUT' };
      });
      await check(17, 'register, unknown field', '400 INVALID_INPUT / UNKNOWN_FIELD', async () => {
        const r = await register({ fullName: 'Asha Verma', role: 'ADMIN' }, rider.token);
        return { actual: `${label(r)} ${detail(r)}`, pass: r.status === 400 && detail(r) === 'role:UNKNOWN_FIELD' };
      });
      await check(18, 'send-otp with a purpose field', '400 INVALID_INPUT / UNKNOWN_FIELD', async () => {
        const r = await call('/rider/auth/send-otp', { phoneNumber: newPhone(), purpose: 'DRIVER_AUTH' });
        return { actual: `${label(r)} ${detail(r)}`, pass: r.status === 400 && detail(r) === 'purpose:UNKNOWN_FIELD' };
      });
    });
  });

  // ---------------------------------------------------------------- Conflicts and bans
  describe('conflicts and bans', () => {
    beforeAll(startApp);

    it('cases 19 to 21', async () => {
      await check(19, 'two riders, same email', '2nd: 409 EMAIL_IN_USE', async () => {
        const [a, b] = [await newRider(), await newRider()];
        const first = await register({ fullName: 'Rider One', email: 'same@example.com' }, a.token);
        const second = await register({ fullName: 'Rider Two', email: 'same@example.com' }, b.token);
        return { actual: `1st ${first.status}, 2nd ${label(second)} field=${second.body?.error?.field}`, pass: first.status === 200 && second.status === 409 && second.body.error.code === 'EMAIL_IN_USE' && second.body.error.field === 'email' };
      });

      await check(20, '5 parallel registers, same email', 'one 200, four 409 EMAIL_IN_USE', async () => {
        const riders = await Promise.all(Array.from({ length: 5 }, () => newRider()));
        const replies = await Promise.all(riders.map((r, i) => register({ fullName: `Rider ${i}x`.replace(/\d/g, 'A'), email: 'race@example.com' }, r.token)));
        const ok = replies.filter((r) => r.status === 200).length;
        const conflicts = replies.filter((r) => r.status === 409 && r.body.error.code === 'EMAIL_IN_USE').length;
        const holders = await pool.query(`SELECT count(*)::int AS n FROM "Rider" WHERE email = 'race@example.com'`);
        return { actual: `${ok}x200, ${conflicts}x409 EMAIL_IN_USE, others=[${replies.map((r) => r.status).join(',')}], rows=${holders.rows[0].n}`, pass: ok === 1 && conflicts === 4 && holders.rows[0].n === 1 };
      });

      await check(21, 'SUSPENDED rider: register, then verify-otp', '403 ACCOUNT_BANNED both', async () => {
        const rider = await newRider();
        await pool.query(`UPDATE "Rider" SET status = 'SUSPENDED' WHERE id = $1`, [rider.id]);
        const reg = await register({ fullName: 'Asha Verma' }, rider.token);
        const login = await loginAgain(rider.phone);
        return { actual: `register ${label(reg)}; verify-otp ${label(login)}`, pass: reg.status === 403 && reg.body.error.code === 'ACCOUNT_BANNED' && login.status === 403 && login.body.error.code === 'ACCOUNT_BANNED' };
      });
    });
  });

  // ---------------------------------------------------------------- Limits
  describe('limits', () => {
    beforeAll(startApp);

    it('cases 22 and 23', async () => {
      await check(22, 'send-otp twice within 30 s', '1st 200, 2nd 429 RATE_LIMITED', async () => {
        const phone = newPhone();
        const first = await send(phone);
        const second = await send(phone);
        return { actual: `1st ${first.status}, 2nd ${label(second)}`, pass: first.status === 200 && second.status === 429 && second.body.error.code === 'RATE_LIMITED' };
      });

      await check(23, '6 wrong codes on one code', '5x 422 OTP_INVALID, 6th 429 OTP_ATTEMPTS_EXCEEDED', async () => {
        const phone = newPhone();
        await send(phone);
        const replies: Reply[] = [];
        for (let i = 0; i < 6; i++) replies.push(await verify(phone, WRONG_CODE));
        const first5 = replies.slice(0, 5).every((r) => r.status === 422 && r.body.error.code === 'OTP_INVALID');
        return { actual: `${replies.map((r) => r.status).join(',')} last=${label(replies[5])}`, pass: first5 && replies[5].status === 429 && replies[5].body.error.code === 'OTP_ATTEMPTS_EXCEEDED' };
      });
    });
  });

  // ---------------------------------------------------------------- Driver sanity
  describe('driver sanity', () => {
    beforeAll(startApp);

    it('cases 24 and 25', async () => {
      const phone = newPhone();
      let driverId = '';
      await check(24, 'driver send-otp + verify-otp (new)', '200 new, DOCUMENTS_PENDING, Ist', async () => {
        const sent = await send(phone, 'driver');
        const r = await verify(phone, FAKE_CODE, 'driver');
        const d = r.body?.data;
        driverId = d?.driver?.id;
        return { actual: `send ${sent.status}; ${label(r)} new=${d?.isNewDriver} ${d?.driver?.status} ist=${d?.driver?.createdAtIst}`, pass: sent.status === 200 && r.status === 200 && d.isNewDriver === true && d.driver.status === 'DOCUMENTS_PENDING' && IST.test(d.driver.createdAtIst) };
      });
      await check(25, 'same driver again', '200 isNewDriver false, same id', async () => {
        await ageSessions(phone);
        await send(phone, 'driver');
        const r = await verify(phone, FAKE_CODE, 'driver');
        const d = r.body?.data;
        return { actual: `${label(r)} new=${d?.isNewDriver} sameId=${d?.driver?.id === driverId}`, pass: r.status === 200 && d.isNewDriver === false && d.driver.id === driverId };
      });
    });
  });

  // ---------------------------------------------------------------- Envelope
  describe('envelope', () => {
    it('case 26 over every response above', async () => {
      await check(26, 'every response has the standard envelope', 'success + data|error + requestId', async () => {
        const bad: string[] = [];
        allReplies.forEach((r, i) => {
          const b = r.body;
          const okShape =
            typeof b?.success === 'boolean' && typeof b.requestId === 'string' && UUID_V4.test(b.requestId) && b.requestId === r.requestId &&
            (b.success ? 'data' in b && !('error' in b) : typeof b.error?.code === 'string' && typeof b.error?.message === 'string' && 'field' in b.error && !('data' in b));
          if (!okShape) bad.push(`#${i}(${r.status})`);
        });
        return { actual: `${allReplies.length} responses checked, ${bad.length} bad ${bad.slice(0, 5).join(' ')}`, pass: allReplies.length > 0 && bad.length === 0 };
      });
    });
  });

  it('every case passed', () => {
    const failed = rows.filter((r) => !r.pass).map((r) => `${r.n} ${r.name}: ${r.actual}`);
    expect(rows).toHaveLength(26);
    expect(failed).toEqual([]);
  });
});
