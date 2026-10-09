import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './env.validation.js';

// AppModule calls ConfigModule.forRoot(...) when it is defined. forRoot is async in
// @nestjs/config 12, so a failing validate is a REJECTED PROMISE, not a thrown error. The spy
// attaches a handler in the same tick, so Vitest does not report an unhandled rejection.
// Placeholders only. AppModule now needs the OTP keys as well as the database and mode.
const OTHER_REQUIRED = {
  OTP_PROVIDER: 'twofactor',
  TWOFACTOR_API_KEY: 'placeholder-2factor-api-key',
};
const captured: Promise<unknown>[] = [];
const original = ConfigModule.forRoot.bind(ConfigModule);

async function importAppModuleWith(env: Record<string, string | undefined>) {
  captured.length = 0;
  const spy = vi.spyOn(ConfigModule, 'forRoot').mockImplementation((options) => {
    const promise = original(options);
    promise.catch(() => undefined);
    captured.push(promise);
    return promise;
  });
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  vi.resetModules();
  await import('../app.module.js');
  const { validateEnv: validateEnvInAppModule } = await import('./env.validation.js');
  return { spy, validateEnvInAppModule };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('AppModule wiring of the environment validation', () => {
  it('calls ConfigModule.forRoot with the real validateEnv', async () => {
    const { spy, validateEnvInAppModule } = await importAppModuleWith({
      DATABASE_URL: 'postgresql://user:pass@127.0.0.1:1/x',
      NODE_ENV: 'test',
      ...OTHER_REQUIRED,
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ isGlobal: true, envFilePath: '.env', validate: validateEnvInAppModule }),
    );
  });

  it('an invalid DATABASE_URL rejects with a message that names the variable and not the value', async () => {
    await importAppModuleWith({ DATABASE_URL: 'not-a-url-SECRET-xyz', NODE_ENV: 'test', ...OTHER_REQUIRED });
    const error = await captured[0].then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(error?.message).toMatch(/DATABASE_URL \(INVALID_FORMAT\)/);
    expect(error?.message).not.toContain('SECRET-xyz');
    expect(String(error?.stack)).not.toContain('SECRET-xyz');
  });

  it('valid values resolve, and process values beat .env (a developer file is not used)', async () => {
    await importAppModuleWith({ DATABASE_URL: 'postgresql://user:pass@127.0.0.1:1/x', NODE_ENV: 'test', ...OTHER_REQUIRED });
    await expect(captured[0]).resolves.toBeDefined();
    expect(process.env.DATABASE_URL).toBe('postgresql://user:pass@127.0.0.1:1/x');
  });

  it('the fake OTP provider in production stops startup and names the key, not a value', async () => {
    await importAppModuleWith({
      DATABASE_URL: 'postgresql://user:pass@127.0.0.1:1/x',
      NODE_ENV: 'production',
      OTP_PROVIDER: 'fake',
      ALLOW_FAKE_OTP: 'true',
      FAKE_OTP_CODE: '654321',
    });
    const error = await captured[0].then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(error?.message).toMatch(/OTP_PROVIDER \(NOT_ALLOWED\)/);
    expect(error?.message).not.toContain('654321');
  });

  it('a missing NODE_ENV is REQUIRED (tested on forRoot directly, so it does not depend on .env)', async () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://user:pass@127.0.0.1:1/x');
    vi.stubEnv('NODE_ENV', undefined);
    await expect(
      ConfigModule.forRoot({ ignoreEnvFile: true, validate: validateEnv }),
    ).rejects.toThrow(/NODE_ENV \(REQUIRED\)/);
  });
});
