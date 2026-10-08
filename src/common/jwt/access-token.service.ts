import { JwtError, signHs256Jwt, verifyHs256Jwt } from './hs256-jwt.js';
import { ACCESS_TOKEN_TTL_SECONDS, DRIVER_ROLE, JWT_ISSUER, RIDER_ROLE } from '../../config/tokens.js';

// What a verified access token tells a route (decision 133): who, which kind of account, which install.
export interface AccessTokenClaims {
  userId: string;
  role: typeof RIDER_ROLE | typeof DRIVER_ROLE;
  deviceId: string;
}

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

  // The other half of sign(): signature, HS256 only, expiry (verifyHs256Jwt), then issuer, role and
  // the three claims a route needs. Throws JwtError for any bad token; the message never holds the token.
  verify(token: string, now: Date): AccessTokenClaims {
    const claims = verifyHs256Jwt(token, this.secret, Math.floor(now.getTime() / 1000));
    const { iss, sub, role, deviceId } = claims;
    if (iss !== JWT_ISSUER) throw new JwtError('wrong issuer');
    if (role !== RIDER_ROLE && role !== DRIVER_ROLE) throw new JwtError('unknown role');
    if (typeof sub !== 'string' || sub === '' || typeof deviceId !== 'string' || deviceId === '') {
      throw new JwtError('missing claim');
    }
    return { userId: sub, role, deviceId };
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
