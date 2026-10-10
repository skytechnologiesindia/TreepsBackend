import { execSync } from 'node:child_process';
import type { INestApplication, Type } from '@nestjs/common';
import { config as loadDotenv } from 'dotenv';
import pg from 'pg';
import { createHash, randomBytes } from 'node:crypto';

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
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const randomToken = () => randomBytes(32).toString('base64url');
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
  const verify = (phone: string, otp = FAKE_CODE, route = 'rider', dev: Record<string, unknown> = device) => call(`/${route}/auth/verify-otp`, { phoneNumber: phone, otp, device: dev });
  const deviceNamed = (deviceId: string) => ({ ...device, deviceId });
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
          /^[A-Za-z0-9_-]{43}$/.test(d.tokens.accessToken) && d.tokens.expiresInSeconds === 2592000 && Object.keys(d.tokens).sort().join() === 'accessToken,expiresInSeconds' &&
          typeof d.rider.createdAt === 'string' && IST.test(d.rider.createdAtIst);
        return { actual: `${label(r)} new=${d?.isNewRider} ${d?.rider?.status} complete=${d?.rider?.isProfileComplete} tokens=${Object.keys(d?.tokens ?? {}).join('+')} ist=${d?.rider?.createdAtIst}`, pass };
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

      await check(10, 'register, no Authorization header', '401 UNAUTHORIZED', async () => is(await register(body), 401, 'UNAUTHORIZED'));
      await check(11, 'register, garbage token', '401 UNAUTHORIZED', async () => is(await register(body, 'not.a.token'), 401, 'UNAUTHORIZED'));
      await check(12, 'register, expired session (30 days)', '401 UNAUTHORIZED', async () => {
        await pool.query(`UPDATE "RefreshToken" SET "expiresAt" = now() - interval '1 second' WHERE "riderId" = $1`, [rider.id]);
        return is(await register(body, rider.token), 401, 'UNAUTHORIZED');
      });
      await check(13, 'register, unknown well-formed token', '401 UNAUTHORIZED', async () => is(await register(body, randomToken()), 401, 'UNAUTHORIZED'));
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

      await check(21, 'SUSPENDED rider: register, then verify-otp', '403 BANNED, sessions deleted, 401 after', async () => {
        const rider = await newRider();
        await pool.query(`UPDATE "Rider" SET status = 'SUSPENDED' WHERE id = $1`, [rider.id]);
        const reg = await register({ fullName: 'Asha Verma' }, rider.token);
        const login = await loginAgain(rider.phone);
        const left = await pool.query(`SELECT count(*)::int AS n FROM "RefreshToken" WHERE "riderId" = $1`, [rider.id]);
        const dead = await register({ fullName: 'Asha Verma' }, rider.token);
        return { actual: `register ${label(reg)}; sessions left=${left.rows[0].n}; token then ${dead.status}; verify-otp ${label(login)}`, pass: reg.status === 403 && reg.body.error.code === 'ACCOUNT_BANNED' && left.rows[0].n === 0 && dead.status === 401 && login.status === 403 && login.body.error.code === 'ACCOUNT_BANNED' };
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

  // ---------------------------------------------------------------- Sessions (server-side, decisions 174 to 178)
  describe('sessions: logout, one active driver session, rider per device, ban, sliding expiry', () => {
    beforeAll(startApp);

    const A = 'e2e-device-A';
    const B = 'e2e-device-B';
    const logout = (role: 'driver' | 'rider', token?: string) => call(`/${role}/auth/logout`, undefined, token);
    async function login(role: 'driver' | 'rider', phone: string, deviceId: string) {
      await ageSessions(phone);
      const sent = await send(phone, role);
      if (sent.status !== 200) throw new Error(`setup: ${role} send-otp gave ${label(sent)}`);
      const r = await verify(phone, FAKE_CODE, role, deviceNamed(deviceId));
      if (r.status !== 200) throw new Error(`setup: ${role} verify-otp gave ${label(r)}`);
      return { phone, token: r.body.data.tokens.accessToken as string, accountId: (r.body.data.rider ?? r.body.data.driver).id as string };
    }
    const sessionRows = async (table: 'RefreshToken' | 'DriverRefreshToken', column: 'riderId' | 'driverId', id: string) =>
      (await pool.query(`SELECT count(*)::int AS n FROM "${table}" WHERE "${column}" = $1`, [id])).rows[0].n as number;

    it('cases 26 to 34', async () => {
      await check(26, 'sliding expiry: written at most once an hour', 'extended once, 2nd call no write', async () => {
        const r = await newRider();
        await pool.query(`UPDATE "RefreshToken" SET "expiresAt" = now() + interval '30 days' - interval '2 hours' WHERE "riderId" = $1`, [r.id]);
        const ms = async () => Number((await pool.query(`SELECT (extract(epoch from "expiresAt") * 1000)::float8 AS ms, extract(epoch from now() + interval '30 days') * 1000 AS target FROM "RefreshToken" WHERE "riderId" = $1`, [r.id])).rows[0].ms);
        const before = await ms();
        const first = await register({ fullName: 'Asha Verma' }, r.token);
        const afterFirst = await ms();
        const second = await register({ fullName: 'Asha Verma' }, r.token);
        const afterSecond = await ms();
        const gainedMs = afterFirst - before;
        return { actual: `${first.status}/${second.status} extended by ${Math.round(gainedMs / 60000)} min, 2nd call changed=${afterSecond !== afterFirst}`, pass: first.status === 200 && second.status === 200 && gainedMs > 100 * 60000 && afterSecond === afterFirst };
      });

      await check(27, 'banned driver (guarded route)', '403 ACCOUNT_BANNED, sessions deleted', async () => {
        const d = await login('driver', newPhone(), A);
        await pool.query(`UPDATE "Driver" SET status = 'SUSPENDED' WHERE id = $1`, [d.accountId]);
        const r = await logout('driver', d.token);
        const again = await logout('driver', d.token);
        const left = await sessionRows('DriverRefreshToken', 'driverId', d.accountId);
        return { actual: `${label(r)}; sessions left=${left}; token then ${again.status}`, pass: r.status === 403 && r.body.error.code === 'ACCOUNT_BANNED' && left === 0 && again.status === 401 };
      });

      await check(28, 'driver logout, then token is dead', '200 loggedOut true; 2nd call 401', async () => {
        const d = await login('driver', newPhone(), A);
        const out = await logout('driver', d.token);
        const again = await logout('driver', d.token);
        const left = await sessionRows('DriverRefreshToken', 'driverId', d.accountId);
        return { actual: `${label(out)} loggedOut=${out.body?.data?.loggedOut}; again ${label(again)}; rows=${left}`, pass: out.status === 200 && out.body.data.loggedOut === true && again.status === 401 && again.body.error.code === 'UNAUTHORIZED' && left === 0 };
      });

      await check(29, 'driver logs in on a 2nd phone', "phone A token dead at once, B works, 1 row", async () => {
        const phone = newPhone();
        const a = await login('driver', phone, A);
        const b = await login('driver', phone, B);
        const count = async () => (await pool.query(`SELECT count(*)::int AS n FROM "DriverDevice" WHERE "driverId" = $1`, [a.accountId])).rows[0].n as number;
        const devicesBefore = await count(); // B replaced A's device row
        const oldA = await logout('driver', a.token);
        const newB = await logout('driver', b.token);
        const devicesAfter = await count(); // logout removes the device row too
        return {
          actual: `A ${label(oldA)}; B ${label(newB)}; devices=${devicesBefore} then ${devicesAfter}`,
          pass: a.accountId === b.accountId && oldA.status === 401 && newB.status === 200 && devicesBefore === 1 && devicesAfter === 0,
        };
      });

      await check(30, 'RIDER logs in on a 2nd device (unchanged)', 'both tokens work, 2 sessions', async () => {
        const phone = newPhone();
        const a = await login('rider', phone, A);
        const b = await login('rider', phone, B);
        const ra = await register({ fullName: 'Asha Verma' }, a.token);
        const rb = await register({ fullName: 'Asha Verma' }, b.token);
        const rows = await sessionRows('RefreshToken', 'riderId', a.accountId);
        return { actual: `A ${ra.status}; B ${rb.status}; sessions=${rows}`, pass: ra.status === 200 && rb.status === 200 && rows === 2 };
      });

      await check(31, 'rider same device logs in again', 'old token 401, new works, 1 session', async () => {
        const phone = newPhone();
        const first = await login('rider', phone, A);
        const second = await login('rider', phone, A);
        const oldR = await register({ fullName: 'Asha Verma' }, first.token);
        const newR = await register({ fullName: 'Asha Verma' }, second.token);
        const rows = await sessionRows('RefreshToken', 'riderId', first.accountId);
        return { actual: `old ${oldR.status}; new ${newR.status}; sessions=${rows}`, pass: oldR.status === 401 && newR.status === 200 && rows === 1 };
      });

      await check(32, 'rider logout, then token is dead', '200 loggedOut true; register 401', async () => {
        const r = await login('rider', newPhone(), A);
        const out = await logout('rider', r.token);
        const reg = await register({ fullName: 'Asha Verma' }, r.token);
        return { actual: `${label(out)} loggedOut=${out.body?.data?.loggedOut}; register then ${label(reg)}`, pass: out.status === 200 && out.body.data.loggedOut === true && reg.status === 401 };
      });

      await check(33, 'logout: no token, and wrong role', '401; rider token on driver 403 both ways', async () => {
        const rider = await login('rider', newPhone(), A);
        const driver = await login('driver', newPhone(), A);
        const none = await logout('driver');
        const riderOnDriver = await logout('driver', rider.token);
        const driverOnRider = await logout('rider', driver.token);
        return { actual: `none ${none.status}; rider on driver ${label(riderOnDriver)}; driver on rider ${label(driverOnRider)}`, pass: none.status === 401 && riderOnDriver.status === 403 && riderOnDriver.body.error.code === 'FORBIDDEN' && driverOnRider.status === 403 };
      });

      await check(34, 'only the SHA-256 hash is stored', 'hash row exists, token text nowhere', async () => {
        const r = await newRider();
        const hashed = await pool.query(`SELECT count(*)::int AS n FROM "RefreshToken" WHERE "tokenHash" = $1`, [sha256(r.token)]);
        const plain = await pool.query(`SELECT count(*)::int AS n FROM "RefreshToken" WHERE "tokenHash" = $1`, [r.token]);
        return { actual: `hash rows=${hashed.rows[0].n}; plain rows=${plain.rows[0].n}`, pass: hashed.rows[0].n === 1 && plain.rows[0].n === 0 };
      });
    });
  });

  // ---------------------------------------------------------------- Profile fields and the device row
  describe('profile fields, terms proof and the device row (2026-10-10)', () => {
    beforeAll(startApp);

    const sdev = (extra: Record<string, unknown> = {}, deviceId = 'e2e-dev-1') => ({ deviceId, platform: 'ANDROID', appVersion: '1.4.2', ...extra });
    const riderRow = async (id: string) => (await pool.query(`SELECT * FROM "Rider" WHERE id = $1`, [id])).rows[0];
    const deviceRows = async (id: string) => (await pool.query(`SELECT * FROM "Device" WHERE "riderId" = $1`, [id])).rows;
    async function fresh(dev: Record<string, unknown>) {
      const phone = newPhone();
      await send(phone);
      const r = await call('/rider/auth/verify-otp', { phoneNumber: phone, otp: FAKE_CODE, device: dev });
      if (r.status !== 200) throw new Error(`setup: verify-otp gave ${label(r)}`);
      return { phone, id: r.body.data.rider.id as string, token: r.body.data.tokens.accessToken as string, reply: r };
    }
    async function again(phone: string, dev: Record<string, unknown>) {
      await ageSessions(phone);
      await send(phone);
      return call('/rider/auth/verify-otp', { phoneNumber: phone, otp: FAKE_CODE, device: dev });
    }

    it('cases 36 to 44', async () => {
      const r = await fresh(sdev({ fcmToken: 'e2e-fcm-token-1' }));

      await check(36, 'verify-otp stores platform, version, fcm on Device', '1 row, IOS/ANDROID, version, token', async () => {
        const rows = await deviceRows(r.id);
        const text = JSON.stringify(r.reply.body);
        return {
          actual: `rows=${rows.length} ${rows[0]?.platform} ${rows[0]?.appVersion} fcm=${rows[0]?.fcmToken ? 'set' : 'null'}`,
          pass: rows.length === 1 && rows[0].platform === 'ANDROID' && rows[0].appVersion === '1.4.2' && rows[0].fcmToken === 'e2e-fcm-token-1' && !text.includes('e2e-fcm-token-1') && !text.includes('appVersion'),
        };
      });

      await check(37, 'register completes: new fields, terms proof set', '200, address, Title Case, terms set, no gender key', async () => {
        const reg = await register({ fullName: '  Asha   Verma ', email: ' E2E.Fields@Example.COM ', registeredCity: 'ranchi', registeredState: 'JHARKHAND', registeredAddress: '12/B, Main Road (near Park) #4' }, r.token);
        const row = await riderRow(r.id);
        const d = reg.body?.data?.rider;
        return {
          actual: `${label(reg)} gender-key=${d !== undefined && 'gender' in d} ${d?.registeredCity}/${d?.registeredState} v=${d?.termsVersion} ist=${d?.termsAcceptedAtIst}`,
          pass:
            reg.status === 200 && d.fullName === 'Asha Verma' && !('gender' in d) && d.email === 'e2e.fields@example.com' && d.registeredCity === 'Ranchi' && d.registeredState === 'Jharkhand' &&
            d.registeredAddress === '12/B, Main Road (near Park) #4' && d.termsVersion === '2026-10-v1' && IST.test(d.termsAcceptedAtIst) && row.termsAcceptedAt !== null && row.termsVersion === '2026-10-v1',
        };
      });

      await check(38, 'second register: terms not overwritten', 'same termsAcceptedAt', async () => {
        const before = await riderRow(r.id);
        const reg = await register({ registeredCity: 'Ranchi' }, r.token);
        const after = await riderRow(r.id);
        return {
          actual: `${label(reg)} same=${before.termsAcceptedAt?.getTime() === after.termsAcceptedAt?.getTime()}`,
          pass: reg.status === 200 && before.termsAcceptedAt.getTime() === after.termsAcceptedAt.getTime(),
        };
      });

      await check(39, 'old ACTIVE rider (NULL new columns) registers again', '200, columns stay NULL', async () => {
        const old = await fresh(sdev({}, 'e2e-dev-old'));
        await pool.query(`UPDATE "Rider" SET status = 'ACTIVE', "isProfileComplete" = true, "fullName" = 'Old Rider' WHERE id = $1`, [old.id]);
        const reg = await register({ fullName: 'Old Rider Two' }, old.token);
        const row = await riderRow(old.id);
        return {
          actual: `${label(reg)} addr=${row.registeredAddress} terms=${row.termsAcceptedAt}`,
          pass: reg.status === 200 && row.registeredAddress === null && row.termsAcceptedAt === null && row.termsVersion === null,
        };
      });

      await check(40, 'gender is rejected as UNKNOWN_FIELD; no gender in replies', '400 UNKNOWN_FIELD; 200 without gender key; column NULL', async () => {
        const p = await fresh(sdev({}, 'e2e-dev-p'));
        const reasons = (x: Reply) => (x.body?.error?.details ?? []).map((d: { field: string; reason: string }) => `${d.field}:${d.reason}`).join(',');
        const withGender = await register({ fullName: 'Asha Verma', gender: 'MALE' }, p.token);
        const rowBefore = await riderRow(p.id);
        const done = await register({ fullName: 'Asha Verma' }, p.token);
        const withMass = await register({ fullName: 'Asha Verma', termsAccepted: true, termsAcceptedAt: '2000-01-01T00:00:00.000Z', platform: 'IOS' }, p.token);
        const row = await riderRow(p.id);
        const verified = await again(p.phone, sdev({}, 'e2e-dev-p'));
        return {
          actual: `${withGender.status} ${reasons(withGender)} status=${rowBefore.status}; ${done.status} gender-key=${'gender' in (done.body?.data?.rider ?? {})}; mass ${withMass.status}; verify-otp gender-key=${'gender' in (verified.body?.data?.rider ?? {})}`,
          pass:
            withGender.status === 400 && reasons(withGender) === 'gender:UNKNOWN_FIELD' && rowBefore.status === 'PROFILE_PENDING' &&
            done.status === 200 && !('gender' in done.body.data.rider) && row.gender === null &&
            withMass.status === 400 && reasons(withMass).split(',').every((x: string) => x.endsWith(':UNKNOWN_FIELD')) &&
            verified.status === 200 && !('gender' in verified.body.data.rider),
        };
      });

      await check(41, 'later login refreshes the row; missing fcm keeps the token', 'IOS/2.0.0, token kept, then replaced', async () => {
        const second = await again(r.phone, sdev({ platform: 'IOS', appVersion: '2.0.0+7' }));
        const afterKeep = (await deviceRows(r.id))[0];
        const third = await again(r.phone, sdev({ fcmToken: null }));
        const afterNull = (await deviceRows(r.id))[0];
        const fourth = await again(r.phone, sdev({ fcmToken: 'e2e-fcm-token-2' }));
        const rows = await deviceRows(r.id);
        return {
          actual: `${second.status}/${third.status}/${fourth.status} rows=${rows.length} ${afterKeep?.platform} ${afterKeep?.appVersion} keep=${afterKeep?.fcmToken} null=${afterNull?.fcmToken} new=${rows[0]?.fcmToken}`,
          pass:
            [second, third, fourth].every((x) => x.status === 200) && rows.length === 1 && afterKeep.platform === 'IOS' && afterKeep.appVersion === '2.0.0+7' &&
            afterKeep.fcmToken === 'e2e-fcm-token-1' && afterNull.fcmToken === 'e2e-fcm-token-1' && rows[0].fcmToken === 'e2e-fcm-token-2',
        };
      });

      await check(42, 'lastLoginAt moves on every verify-otp', 'later than the first login', async () => {
        const first = (await riderRow(r.id)).lastLoginAt as Date;
        await again(r.phone, sdev());
        const second = (await riderRow(r.id)).lastLoginAt as Date;
        return { actual: `${first.toISOString()} -> ${second.toISOString()}`, pass: second.getTime() > first.getTime() };
      });

      await check(43, 'bad device bodies are rejected', '400 for platform/version/fcm problems, no echo', async () => {
        const phone = newPhone();
        await send(phone);
        const bad = async (device: Record<string, unknown>) => call('/rider/auth/verify-otp', { phoneNumber: phone, otp: FAKE_CODE, device });
        const noPlatform = await bad({ deviceId: 'e2e-dev-x', appVersion: '1.4.2' });
        const renamed = await bad({ deviceId: 'e2e-dev-x', platform: 'ANDROID', devicePlatform: 'ANDROID', appVersion: '1.4.2' });
        const winPlatform = await bad(sdev({ platform: 'WINDOWS' }));
        const noVersion = await bad({ deviceId: 'e2e-dev-x', platform: 'IOS' });
        const longVersion = await bad(sdev({ appVersion: 'a'.repeat(21) }));
        const spaceToken = await bad(sdev({ fcmToken: 'SECRET TOKEN' }));
        const emptyToken = await call('/rider/auth/verify-otp', { phoneNumber: phone, otp: FAKE_CODE, device: sdev({ fcmToken: '' }, 'e2e-dev-empty') });
        const all = [noPlatform, renamed, winPlatform, noVersion, longVersion, spaceToken];
        return {
          actual: `${all.map((x) => x.status).join('/')}; empty fcm ${emptyToken.status}`,
          pass: emptyToken.status === 200 && all.every((x) => x.status === 400 && x.body.error.code === 'INVALID_INPUT') && !JSON.stringify(spaceToken.body).includes('SECRET'),
        };
      });

      await check(44, 'logout deletes the Device row (the token dies); driver too', '0 rows after logout (rider and driver)', async () => {
        // A fresh rider: r.phone has used up its send-otp allowance in the cases above.
        const lo = await fresh(sdev({ fcmToken: 'e2e-fcm-token-3' }, 'e2e-dev-lo'));
        const before = await deviceRows(lo.id);
        const out = await call('/rider/auth/logout', undefined, lo.token);
        const riderRows = await deviceRows(lo.id);
        const dphone = newPhone();
        await send(dphone, 'driver');
        const dv = await verify(dphone, FAKE_CODE, 'driver', sdev({ fcmToken: 'e2e-fcm-driver' }, 'e2e-dev-drv'));
        const driverId = dv.body.data.driver.id as string;
        const stored = (await pool.query(`SELECT * FROM "DriverDevice" WHERE "driverId" = $1`, [driverId])).rows;
        const dout = await call('/driver/auth/logout', undefined, dv.body.data.tokens.accessToken);
        const after = (await pool.query(`SELECT count(*)::int AS n FROM "DriverDevice" WHERE "driverId" = $1`, [driverId])).rows[0].n as number;
        return {
          actual: `rider ${out.status} rows=${before.length} then ${riderRows.length}; driver stored=${stored.length}/${stored[0]?.platform}/${stored[0]?.fcmToken ? 'tok' : 'null'} logout ${dout.status} rows=${after}`,
          pass: out.status === 200 && before.length === 1 && riderRows.length === 0 && stored.length === 1 && stored[0].platform === 'ANDROID' && stored[0].fcmToken === 'e2e-fcm-driver' && dout.status === 200 && after === 0,
        };
      });
    });
  });

  // ---------------------------------------------------------------- Envelope
  describe('envelope', () => {
    it('case 45 over every response above', async () => {
      await check(45, 'every response has the standard envelope', 'success + data|error + requestId', async () => {
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
    expect(rows).toHaveLength(44);
    expect(failed).toEqual([]);
  });
});
