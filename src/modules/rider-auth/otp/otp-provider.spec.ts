import { OTP_PROVIDER_NOT_BUILT, OtpProviderNotBuiltError } from '../../../config/otp-provider-not-built.error.js';
import { FAKE_SESSION_PREFIX, FakeOtpProvider } from './fake-otp.provider.js';
import { createOtpProvider } from './otp-provider.factory.js';

describe('FakeOtpProvider', () => {
  const provider = new FakeOtpProvider('123456');

  it('send returns a fake session id and makes no network call', async () => {
    const { providerSessionId } = await provider.send('+919477172214');
    expect(providerSessionId.startsWith(FAKE_SESSION_PREFIX)).toBe(true);
    expect(await provider.send('+919477172214')).not.toEqual({ providerSessionId });
  });

  it('verify is true only for the configured code and a fake session', async () => {
    const { providerSessionId } = await provider.send('+919477172214');
    expect(await provider.verify(providerSessionId, '123456')).toBe(true);
    expect(await provider.verify(providerSessionId, '654321')).toBe(false);
    expect(await provider.verify(providerSessionId, '')).toBe(false);
    expect(await provider.verify('real-session', '123456')).toBe(false);
  });
});

describe('createOtpProvider', () => {
  it('fake gives a FakeOtpProvider that uses FAKE_OTP_CODE', async () => {
    const provider = createOtpProvider('fake', '246810');
    expect(provider).toBeInstanceOf(FakeOtpProvider);
    const { providerSessionId } = await provider.send('+919477172214');
    expect(await provider.verify(providerSessionId, '246810')).toBe(true);
  });

  it('twofactor fails with the clear "not built yet" error, and never falls back to the fake', () => {
    expect(() => createOtpProvider('twofactor', '123456')).toThrow(OtpProviderNotBuiltError);
    expect(() => createOtpProvider('twofactor', undefined)).toThrow(/twofactor client not built yet \(blocked on M0\)/);
    expect(OTP_PROVIDER_NOT_BUILT).toContain('twofactor client not built yet (blocked on M0)');
  });
});
