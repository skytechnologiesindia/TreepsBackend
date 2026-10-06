import { OtpProviderNotBuiltError } from '../../../config/otp-provider-not-built.error.js';
import type { OtpProviderName } from '../../../config/env.validation.js';
import { FakeOtpProvider } from './fake-otp.provider.js';
import type { OtpProvider } from './otp-provider.js';

// Chooses the provider once, at startup, from OTP_PROVIDER. The env validation has already checked
// the keys each choice needs (and refused the fake provider in production).
export function createOtpProvider(name: OtpProviderName, fakeCode: string | undefined): OtpProvider {
  if (name === 'fake') {
    if (fakeCode === undefined) throw new TypeError('FAKE_OTP_CODE is missing'); // the env validation prevents this
    return new FakeOtpProvider(fakeCode);
  }
  // The real 2Factor client is not built yet (blocked on M0): refuse to start, never fall back.
  throw new OtpProviderNotBuiltError();
}
