import { DRIVER_ROLE, RIDER_ROLE } from '../../config/tokens.js';

export type SessionRole = typeof RIDER_ROLE | typeof DRIVER_ROLE;

// What a route learns about the caller after the guard (read it with @AuthUser()). In Express terms,
// `req.user`.
export interface AuthClaims {
  userId: string;
  role: SessionRole;
  deviceId: string;
}

// The `tokens` object in verify-otp replies. accessToken is the opaque session token (decision 174);
// the name is kept so the apps' code does not change.
export interface SessionTokens {
  accessToken: string;
  expiresInSeconds: number;
}

// One stored session, without the token hash.
export interface Session {
  id: string;
  role: SessionRole;
  accountId: string;
  deviceId: string;
  expiresAt: Date;
}
