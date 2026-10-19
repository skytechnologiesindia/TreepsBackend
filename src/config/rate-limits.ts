// Every rate-limit number in one place (decision 139: tunable numbers are constants in a config
// file, not hard-coded in controllers). The values come from the approved rider auth docs.
// The IP limits are enforced by the in-memory guard (src/common/rate-limit/). The per-phone
// numbers for send-otp and verify-otp are counted by the services from OtpSession rows, so they
// survive a restart and are shared between server instances; they are listed here only so every
// number lives in one file.
const SECOND_MS = 1000;
const HOUR_MS = 60 * 60 * SECOND_MS;

export const RATE_LIMITS = {
  // docs/api/rider-send-otp.md
  sendOtp: {
    ip: { limit: 20, windowMs: HOUR_MS },
    phone: { limit: 5, windowMs: HOUR_MS }, // counted from OtpSession rows
    resendCooldownMs: 30 * SECOND_MS, // counted from OtpSession rows
  },
  // docs/api/rider-verify-otp.md: no per-IP limit in the MVP
  verifyOtp: {
    phone: { limit: 10, windowMs: HOUR_MS }, // counted from OtpSession.attempts
  },
  // docs/api/rider-register.md
  register: { ip: { limit: 10, windowMs: HOUR_MS } },
  // docs/api/rider-logout.md and driver-logout.md (decision 137)
  logout: { ip: { limit: 120, windowMs: HOUR_MS } },

  // docs/api/driver/driver-document-requirements.md
  documentRequirements: { ip: { limit: 120, windowMs: HOUR_MS } },
  // docs/api/driver/driver-onboarding-submit.md
  onboardingSubmit: { ip: { limit: 10, windowMs: HOUR_MS } },
  // docs/api/driver/driver-me.md (proposal, TO DECIDE; high because many phones share one mobile IP)
  driverMe: { ip: { limit: 600, windowMs: HOUR_MS } },
  // docs/api/admin/admin-login.md (proposal, TO DECIDE)
  adminLogin: { ip: { limit: 10, windowMs: HOUR_MS } },
  // docs/api/admin/admin-driver-submissions.md (proposal, TO DECIDE)
  adminDriverSubmissions: { ip: { limit: 600, windowMs: HOUR_MS } },
} as const;
