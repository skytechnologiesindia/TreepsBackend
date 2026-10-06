import { randomUUID } from 'node:crypto';
import type { OtpProvider } from './otp-provider.js';

export const FAKE_SESSION_PREFIX = 'fake-session-';

// For development and tests only. No network call. verify() is true only for the one code taken
// from FAKE_OTP_CODE. The env validation refuses to start with it in production.
export class FakeOtpProvider implements OtpProvider {
  constructor(private readonly code: string) {}

  async send(_phoneNumber: string): Promise<{ providerSessionId: string }> {
    return { providerSessionId: `${FAKE_SESSION_PREFIX}${randomUUID()}` };
  }

  async verify(providerSessionId: string, otp: string): Promise<boolean> {
    return providerSessionId.startsWith(FAKE_SESSION_PREFIX) && otp === this.code;
  }
}
