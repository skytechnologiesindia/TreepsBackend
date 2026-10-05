# POST /v1/rider/auth/refresh

Status: APPROVED (owner, 2026-10-05). Items still marked TO DECIDE must be resolved in this doc before the code that needs them is written (CLAUDE.md rule 12). A change after approval needs a changelog row.

Part of the unified phone-OTP flow (see the diagram in `rider-send-otp.md`). The path `/v1/rider/auth/refresh` is APPROVED; the controller writes `@Controller('rider/auth')` and never `v1`.

## Purpose
The app trades its refresh token for a new access token and a new refresh token, without asking the rider to type a code again. The exchange is **rotating**: the old refresh token dies the moment the new one is issued. Presenting an old, already-rotated token is treated as theft and revokes every token of that device.

## Who calls it
Rider app, when the access token (15 minutes) is about to expire or has expired. Public endpoint in the sense that it takes no access token (the expired access token is the reason it is called); the refresh token itself is the credential. Role: the Rider role is attached to the new access token. Gate checks: throttler guard, validation, token checks. The user id comes from the stored token row, never from the request.

## Request fields
Body, JSON. Nothing else is accepted; unknown fields are rejected with `UNKNOWN_FIELD`.

| Name | Type | Unit | Required? | Allowed range | Why it exists | Why this type/unit | Bucket | What breaks if wrong |
|---|---|---|---|---|---|---|---|---|
| refreshToken | string | opaque text | Required | 43 characters, base64url (32 random bytes; encoding APPROVED) | The credential being exchanged | Opaque random value, not a JWT, so it can be revoked server-side | Identity | A forged value is rejected; a short or odd value is rejected before any lookup |
| deviceId | string | text | Required | 1 to 64 characters, only `A-Z a-z 0-9 _ -` (decision 132) | Must match the device the token was issued to | Same install id as in verify-otp and register | Identity | A token stolen to another device is refused |

Shared types (`input-validation.md` section 2b): `OpaqueToken`, `DeviceId`.

## Response fields
Success: HTTP 200 (APPROVED). `data` is `{ tokens }`, the same object as `tokens` in `rider-register.md` Response fields (`accessToken`, `accessTokenExpiresInSeconds` 900, `refreshToken`, `refreshTokenExpiresInSeconds` 2592000). No `rider` object (the app already has it).

## Derived values
- The new access token (signed JWT, 15 minutes, HS256; claims in `rider-register.md` Derived values, decision 133) and the new refresh token (32 random bytes from `crypto.randomBytes`, base64url; only its SHA-256 hash is stored).
- New refresh token lifetime: **a fresh 30 days from the moment of each rotation** (sliding, decision 124), so an active rider is never logged out. A fixed lifetime from login was not chosen.

## Order of operations
1. Throttler guard (IP): 120 per IP per hour (decision 137).
2. Validate the body.
3. Hash the presented token (SHA-256) and look up the `RefreshToken` row by `tokenHash`:
   - no row: `UNAUTHORIZED`.
4. The row's `deviceId` is not the request's `deviceId`: `UNAUTHORIZED` (not counted as reuse).
5. **Reuse check:** the row's `revokedAt` is already set. This token was rotated or logged out earlier. Revoke every unrevoked `RefreshToken` of this `(riderId, deviceId)` (set `revokedAt`), write a log event (`requestId` only, decision 134), reply `UNAUTHORIZED`. The rider must verify a code again on that device.
6. `expiresAt` has passed: `UNAUTHORIZED`.
7. Load the rider. If `status` is not ACTIVE: revoke the device's tokens, reply `ACCOUNT_BANNED`.
8. One database transaction: a **conditional update** sets `revokedAt` on this row only where `revokedAt` is still null (if no row changes, a parallel request rotated it first: treat as step 5); create the new `RefreshToken` row for the same `(riderId, deviceId)`; set `Device.lastSeenAt`.
9. Sign the access token and reply 200.

## Reference data used
Access TTL 900 s, refresh TTL 2592000 s, config only. No grace window in the MVP (decision 125, see Edge cases).

## State changes
- Before: one unrevoked token for the device. After: that row has `revokedAt` set (kept, never deleted, so reuse can be detected) and one new unrevoked row exists.
- Idempotency: not replayable by design. A repeat of the same request is a reuse of a rotated token.
- Concurrency: the conditional update lets exactly one of two parallel refreshes win.

## Data stored
`RefreshToken` rows (hash only, never the token), `Device.lastSeenAt`. Revoked and expired rows are kept; no cleanup job in the MVP (decision 144).

## Errors
All errors use the envelope in `standards/response-format.md`.

| Code | HTTP status | When it happens | `field` marker | Rider-safe message | How the app UI should react |
|---|---|---|---|---|---|
| INVALID_INPUT | 400 | Missing, wrong type, wrong format or unknown field | first invalid field | "Please check your input." | Treat as a bug; do not retry |
| UNAUTHORIZED | 401 | Unknown token, wrong device, revoked token (reuse), or expired token | null | "Please log in again." | Clear the stored tokens and start phone login again |
| ACCOUNT_BANNED | 403 | The rider is no longer ACTIVE | null | "This account can't book rides." (proposed in `estimate.md`; the same wording is used here, decision 144) | Show support contact |
| RATE_LIMITED | 429 | More than 120 requests per hour from one IP | null | "Too many requests. Try again shortly." | Retry later |
| INTERNAL_ERROR | 500 | A bug or a database failure | null | "Something went wrong. Please try again." | Retry; the old token is still valid because the transaction rolled back |

All four token failures give the same code and message, so the reply never tells an attacker which check failed.

## Rate limit, logging and audit
- Rate limit: 120 per IP per hour (decision 137, raised because many riders share one mobile-carrier address), by the in-memory throttler guard in `rider-send-otp.md` (client IP per `TRUST_PROXY_HOPS`, decision 123).
- Log: `requestId`, code, status. Never the refresh token, its hash, or the device id.
- Audit events: no audit table in the MVP (decision 134). One structured log line per event in the existing key=value style, with the `requestId` and a fixed event name only (`refresh.reuse_detected`, `refresh.banned`).

## Edge cases and known limitations
- **Retry after a lost reply logs the device out.** If the server rotated the token but the response never reached the app, the app retries with the old token and triggers reuse detection. A short grace window would avoid it but weakens theft detection. **Decision 125: no grace window in the MVP.** A lost reply logs the device out and the rider verifies a code again.
- Access tokens already issued stay valid until they expire, even after a revocation (stateless JWT). The deferred `tokenVersion` column would close that gap.
- One refresh token per device: a second device has its own `Device` row and token, unaffected.
- A device whose tokens were revoked has no unrevoked token until it completes verify-otp again.

## Required tests
- Happy path: 200; new tokens; the old row has `revokedAt`; one unrevoked row for the device; stored values are SHA-256 hashes that differ from the returned tokens; `Device.lastSeenAt` updated.
- No token: not applicable (the refresh token is the credential). Wrong role: not applicable.
- Blocked account: a rider SUSPENDED or BLOCKED after login gets `ACCOUNT_BANNED` and the device's tokens are revoked.
- Invalid input: missing fields, wrong types, a token of the wrong length, unknown field.
- `UNAUTHORIZED` for: an unknown token, a token for another `deviceId`, an expired token, a revoked token. Each reply is identical.
- Rotation: the second use of the same token is reuse.
- Reuse: after reuse, the newest token of that device is also revoked; a different device of the same rider is not.
- Duplicate call and race condition: two simultaneous refreshes with one token (exactly one 200; the other is `UNAUTHORIZED` and triggers the reuse path).
- Transaction failure: if inserting the new token fails, the old token is still unrevoked.
- Secrets: no token, hash or device id in any log line.

## Changelog
| Date | What changed | Why |
|---|---|---|
| 2026-10-05 | Draft created: rotating refresh, reuse revokes the device's tokens | Owner's unified flow brief |
| 2026-10-05 | Status changed from PROPOSED to APPROVED; sliding 30-day refresh lifetime, no grace window, 30 per IP per hour | Owner approval and decisions 120 to 129 |
| 2026-10-05 | 120 per IP per hour; HS256 JWT; `deviceId` rule; no audit table | Owner decisions 130 to 140 |
| 2026-10-05 | token cleanup and ban wording settled (decision 144) | Owner decisions 141 to 145 |
