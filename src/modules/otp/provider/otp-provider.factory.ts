import type { OtpProviderName } from '../../../config/env.validation.js';
import { FakeOtpProvider } from './fake-otp.provider.js';
import type { OtpProvider } from './otp-provider.js';
import { TwoFactorOtpProvider } from './twofactor-otp.provider.js';

export interface OtpProviderSettings {
  fakeCode?: string;
  twoFactorApiKey?: string;
  twoFactorTemplate?: string;
}

// Chooses the provider once, at startup, from OTP_PROVIDER. The env validation has already checked
// the keys each choice needs (and refused the fake provider in production).
export function createOtpProvider(name: OtpProviderName, settings: OtpProviderSettings): OtpProvider {
  if (name === 'fake') {
    if (settings.fakeCode === undefined) throw new TypeError('FAKE_OTP_CODE is missing'); // the env validation prevents this
    return new FakeOtpProvider(settings.fakeCode);
  }
  if (settings.twoFactorApiKey === undefined) throw new TypeError('TWOFACTOR_API_KEY is missing'); // the env validation prevents this
  return new TwoFactorOtpProvider({
    apiKey: settings.twoFactorApiKey,
    template: settings.twoFactorTemplate ?? DEFAULT_TWOFACTOR_TEMPLATE,
  });
}

const DEFAULT_TWOFACTOR_TEMPLATE = 'OTP1';
