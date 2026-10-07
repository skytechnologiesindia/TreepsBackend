import { signHs256Jwt } from './hs256-jwt.js';
import { ACCESS_TOKEN_TTL_SECONDS, DRIVER_ROLE, JWT_ISSUER, RIDER_ROLE } from '../../config/tokens.js';

// The token pair a successful login returns (rider and driver).
export interface AuthTokens {
  accessToken: string;
  accessTokenExpiresInSeconds: number;
  refreshToken: string;
  refreshTokenExpiresInSeconds: number;
}

// Signs access tokens (decision 133): HS256, issuer "treeps", claims sub (the rider or driver id),
// role and deviceId, plus iat and exp. The role is RIDER or DRIVER and is the only thing that tells
// the two apart: a guard must check it (decision 158). The secret is JWT_ACCESS_SECRET and never
// leaves here.
export class AccessTokenService {
  constructor(private readonly secret: string) {}

  issue(input: { riderId: string; deviceId: string; now: Date }): { token: string; expiresInSeconds: number } {
    return this.sign(input.riderId, RIDER_ROLE, input.deviceId, input.now);
  }

  issueForDriver(input: { driverId: string; deviceId: string; now: Date }): { token: string; expiresInSeconds: number } {
    return this.sign(input.driverId, DRIVER_ROLE, input.deviceId, input.now);
  }

  private sign(subject: string, role: string, deviceId: string, now: Date): { token: string; expiresInSeconds: number } {
    const iat = Math.floor(now.getTime() / 1000);
    const token = signHs256Jwt(
      { iss: JWT_ISSUER, sub: subject, role, deviceId, iat, exp: iat + ACCESS_TOKEN_TTL_SECONDS },
      this.secret,
    );
    return { token, expiresInSeconds: ACCESS_TOKEN_TTL_SECONDS };
  }
}
