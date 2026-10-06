import { signHs256Jwt } from '../../common/jwt/hs256-jwt.js';
import { ACCESS_TOKEN_TTL_SECONDS, JWT_ISSUER, RIDER_ROLE } from '../../config/tokens.js';

// Signs the rider's access token (decision 133): HS256, issuer "treeps", claims sub (rider id),
// role RIDER and deviceId, plus iat and exp. The secret is JWT_ACCESS_SECRET and never leaves here.
export class AccessTokenService {
  constructor(private readonly secret: string) {}

  issue(input: { riderId: string; deviceId: string; now: Date }): { token: string; expiresInSeconds: number } {
    const iat = Math.floor(input.now.getTime() / 1000);
    const token = signHs256Jwt(
      {
        iss: JWT_ISSUER,
        sub: input.riderId,
        role: RIDER_ROLE,
        deviceId: input.deviceId,
        iat,
        exp: iat + ACCESS_TOKEN_TTL_SECONDS,
      },
      this.secret,
    );
    return { token, expiresInSeconds: ACCESS_TOKEN_TTL_SECONDS };
  }
}
