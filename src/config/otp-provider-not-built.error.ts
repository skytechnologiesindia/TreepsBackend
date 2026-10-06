// Thrown at startup when OTP_PROVIDER=twofactor but the real client does not exist yet. The message
// is fixed text with a key name only, so startup-failure.ts may print it (decision 68).
export const OTP_PROVIDER_NOT_BUILT =
  'OTP_PROVIDER=twofactor: twofactor client not built yet (blocked on M0). Use OTP_PROVIDER=fake with ALLOW_FAKE_OTP=true for development.';

export class OtpProviderNotBuiltError extends Error {
  constructor() {
    super(OTP_PROVIDER_NOT_BUILT);
    this.name = 'OtpProviderNotBuiltError';
  }
}
