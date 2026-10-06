// OTP numbers from docs/api/rider-send-otp.md (constants, not environment variables: decision 139).
// The send limits are in rate-limits.ts.
export const OTP_LIFETIME_MS = 5 * 60 * 1000;
export const OTP_PROVIDER_TIMEOUT_MS = 5000; // for the real provider; it never retries
