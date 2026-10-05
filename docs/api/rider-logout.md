# POST /v1/rider/auth/logout

Status: APPROVED (owner, 2026-10-05). Items still marked TO DECIDE must be resolved in this doc before the code that needs them is written (CLAUDE.md rule 12). A change after approval needs a changelog row.

Part of the unified phone-OTP flow (see the diagram in `rider-send-otp.md`). The path `/v1/rider/auth/logout` is APPROVED; the controller writes `@Controller('rider/auth')` and never `v1`.

## Purpose
The rider logs out on this device. The server revokes that device's refresh token so it can never be exchanged again. Other devices of the same rider are not affected.

## Who calls it
Rider app, from the logout button. Public endpoint that takes **the refresh token as the credential** (APPROVED): the app can still log out when its 15-minute access token has expired, and no JWT guard is needed (the JWT guard and the "authenticated user" decorator are F4 work and do not exist yet). It stays public, with the refresh token as the credential, until the JWT guard exists (decision 126); revisit then. Gate checks: throttler guard and validation. The rider and device are read from the stored token row, never from the request.

## Request fields
Body, JSON. Nothing else is accepted; unknown fields are rejected with `UNKNOWN_FIELD`.

| Name | Type | Unit | Required? | Allowed range | Why it exists | Why this type/unit | Bucket | What breaks if wrong |
|---|---|---|---|---|---|---|---|---|
| refreshToken | string | opaque text | Required | 43 characters, base64url (same rule as `refresh`) | Identifies which device's token to revoke and proves the caller holds it | Opaque random value | Identity | Anyone could log out anyone |

Shared types (`input-validation.md` section 2b): `OpaqueToken`.

## Response fields
Success: HTTP 200 with `data: null` (APPROVED; 204 is not used, `response-format.md` rule 14). The reply is the same whether or not the token was known, so the call cannot be used to test tokens.

## Derived values
None. The device is found from the stored token row.

## Order of operations
1. Throttler guard (IP): 120 per IP per hour (decision 137).
2. Validate the body.
3. Hash the presented token (SHA-256) and look up the `RefreshToken` row.
4. If a row exists: set `revokedAt` on every unrevoked `RefreshToken` of that `(riderId, deviceId)` (normally one) and set that `Device.fcmToken` to null so the device stops receiving pushes (decision 144).
5. Reply 200 with `data: null`, also when no row exists or the token was already revoked.

## Reference data used
None.

## State changes
- Before: the device has one unrevoked token. After: all of the device's tokens are revoked (rows kept) and its `fcmToken` is cleared.
- Idempotency: natural. A second logout with the same token changes nothing and still replies 200.
- Concurrency: logout racing a refresh with the same token: whichever commits first wins; if refresh wins, its new token is also revoked by logout only if logout runs after it. The race can leave a fresh unrevoked token for a device whose rider just logged out. Accepted (decision 144): the app discards its tokens on logout.

## Data stored
Updates `RefreshToken.revokedAt` and `Device.fcmToken`. Nothing new is stored.

## Errors
All errors use the envelope in `standards/response-format.md`.

| Code | HTTP status | When it happens | `field` marker | Rider-safe message | How the app UI should react |
|---|---|---|---|---|---|
| INVALID_INPUT | 400 | Missing, wrong type, wrong format or unknown field | first invalid field | "Please check your input." | Treat as a bug |
| RATE_LIMITED | 429 | More than 120 requests per hour from one IP | null | "Too many requests. Try again shortly." | Retry later; the app clears its local tokens regardless |
| INTERNAL_ERROR | 500 | A bug or a database failure | null | "Something went wrong. Please try again." | Retry; the app clears local tokens either way |

An unknown or already-revoked token is not an error (see Response fields).

## Rate limit, logging and audit
- Rate limit: 120 per IP per hour (decision 137, raised because many riders share one mobile-carrier address), by the in-memory throttler guard in `rider-send-otp.md` (client IP per `TRUST_PROXY_HOPS`, decision 123).
- Log: `requestId`, code, status. Never the refresh token or its hash.
- Audit event: no audit table in the MVP (decision 134). One structured log line with the `requestId` and the fixed event name `logout` only.

## Edge cases and known limitations
- The access token stays valid until it expires (15 minutes) even after logout, because it is a stateless JWT. The deferred `tokenVersion` column would close this.
- "Log out of all devices" is not in this feature (decision 144).
- The app must discard both tokens locally even if the call fails.

## Required tests
- Happy path: 200, `data` null; the device's token has `revokedAt`; a later `refresh` with that token is `UNAUTHORIZED`; `Device.fcmToken` is null (if kept).
- Other device untouched: a second device's token still refreshes.
- Unknown token and already-revoked token: 200, same reply, nothing changed.
- No token needed (public). Wrong role and blocked account: not applicable.
- Invalid input: missing token, wrong type, wrong length, unknown field.
- Duplicate call: the second logout is also 200.
- Race condition: logout and refresh with the same token at the same time (outcome per the decision above).
- Secrets: no token or hash in any log line.

## Changelog
| Date | What changed | Why |
|---|---|---|
| 2026-10-05 | Draft created: public, refresh token as the credential, same reply for any token | Owner's unified flow brief |
| 2026-10-05 | Status changed from PROPOSED to APPROVED; logout stays public with the refresh token as the credential until the JWT guard exists; 30 per IP per hour | Owner approval and decisions 120 to 129 |
| 2026-10-05 | 120 per IP per hour; no audit table | Owner decisions 130 to 140 |
| 2026-10-05 | push clean-up on logout, the logout/refresh race and "log out of all devices" settled (decision 144) | Owner decisions 141 to 145 |
