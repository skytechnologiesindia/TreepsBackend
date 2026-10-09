// Token numbers from docs/api/rider-register.md and rider-verify-otp.md (decisions 116, 133).
// Constants, not environment variables (decision 139).
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
export const JWT_ISSUER = 'treeps';
export const RIDER_ROLE = 'RIDER';
export const DRIVER_ROLE = 'DRIVER';
// A rotated refresh token presented again within this time is treated as an app retry (401 only);
// after it, as theft (every session of that account is ended). Decision 171.
export const REFRESH_REUSE_GRACE_MS = 10_000;
