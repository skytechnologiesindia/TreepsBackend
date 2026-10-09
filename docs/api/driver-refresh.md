# POST /v1/driver/auth/refresh

Status: BUILT 2026-10-09 on the owner's instruction (M6, driver only; decisions 170 to 173). Items marked TO DECIDE have no decision yet. A change after approval needs a changelog row. **The rider refresh (`rider-refresh.md`) is not built and not changed by this doc; riders stay deferred.**

The controller writes `@Controller('driver/auth')` and never `v1`. Sibling docs: `driver-verify-otp.md`, `driver-logout.md`, `rider-refresh.md` (the rider design, deferred).

## Purpose
The driver app trades its refresh token for a new access token and a new refresh token without asking for an OTP again. The exchange **rotates**: the old refresh token dies when the new one is issued, and the new one gets a fresh 30 days from that moment.

## Who calls it
Driver app, when the 15-minute access token is about to expire or has expired. **Public route:** no access token is needed (it may already be expired); the refresh token is the credential. No JWT guard. Gate checks: throttler guard (IP), validation, token checks. The driver id comes from the stored token row, never from the request.

## Request fields
Body, JSON. Nothing else is accepted; unknown fields are `UNKNOWN_FIELD`.

| Name | Type | Unit | Required? | Allowed range | Why it exists | Why this type/unit | Bucket | What breaks if wrong |
|---|---|---|---|---|---|---|---|---|
| refreshToken | string | opaque text | Required | 1 to 512 characters, no U+0000. **Any other shape is not a 400:** a malformed value is `REFRESH_TOKEN_INVALID` like an unknown one. A missing value, `""` or a non-string is `INVALID_INPUT` | The credential being exchanged | Opaque random value (43 base64url characters when real), not a JWT, so it can be revoked server-side | Identity | A forged value is refused with the same error as every other bad token |
| deviceId | string | text | Required | 1 to 64 characters, only `A-Z a-z 0-9 _ -` (`DeviceId` type) | Must match the device the token was issued to | Same install id as in verify-otp | Identity | A token used from another device is refused |

Why the token is not format-checked: the owner asked that unknown, expired, malformed, wrong-role and wrong-device tokens all give one error with no detail. (`rider-refresh.md` still says a malformed rider token is a 400; that is the rider design and is not changed here.)

## Response fields
Success: **HTTP 200**, `data` is `{ tokens }`, the same object as `tokens` in `driver-verify-otp.md`:

| Name | Type | Unit | Required? | Allowed range | Why it exists | Bucket |
|---|---|---|---|---|---|---|
| tokens.accessToken | string | JWT (HS256) | Always | claims `iss` `treeps`, `sub` the driver id, `role` `DRIVER`, `deviceId`, `iat`, `exp` | Authorises calls for 15 minutes | Derived |
| tokens.accessTokenExpiresInSeconds | number | seconds | Always | `900` | Lets the app schedule the next refresh | Derived |
| tokens.refreshToken | string | opaque | Always | 43 base64url characters; **new every time** | The next exchange | Derived |
| tokens.refreshTokenExpiresInSeconds | number | seconds | Always | `2592000` (30 days, counted from this call) | Lets the app know the session length | Derived |

No `driver` object (the app already has it). No date-time field, so no `Ist` twin is added.

## Derived values
- Access token: signed by `AccessTokenService.issueForDriver` (decision 133). Refresh token: 32 random bytes (`crypto.randomBytes`), base64url; only its SHA-256 hash is stored.
- New refresh token lifetime: a fresh 30 days from the moment of each rotation (sliding, decision 124).

## Order of operations
1. Throttler guard (IP): 120 per IP per hour (decision 137), counter name `driver-refresh`.
2. Validate the body.
3. Hash the token (SHA-256) and look up the `DriverRefreshToken` row by `tokenHash`. No row, or the row's `deviceId` is not the request's: `REFRESH_TOKEN_INVALID`. (Only driver tokens live in this table, so a rider token is simply unknown. A wrong device is not counted as reuse and revokes nothing.)
4. **Reuse check.** The row's `revokedAt` is set: this token was already rotated (or replaced by a newer login).
   - Rotated **more than 10 seconds ago**: treated as theft. Every `DriverRefreshToken` and `DriverDevice` row of this driver is deleted in one transaction (every session ends), and the reply is `REFRESH_TOKEN_INVALID`.
   - Rotated **within 10 seconds**: an app retry or double-fire. Only `REFRESH_TOKEN_INVALID`; nothing is revoked.
5. `expiresAt` has passed: `REFRESH_TOKEN_INVALID` (nothing is revoked).
6. Load the driver. `SUSPENDED`, `BLOCKED` or `DELETED`: delete all the driver's sessions (as in step 4) and reply `ACCOUNT_BANNED` (403). No row for the driver: `REFRESH_TOKEN_INVALID`.
7. One transaction: a **conditional update** sets `revokedAt` = now on this row only where `revokedAt` is still null and the token is unexpired (if no row changes, a parallel call rotated it first: `REFRESH_TOKEN_INVALID`, the transaction is rolled back); create the new `DriverRefreshToken` row for the same `(driverId, deviceId)`; set `DriverDevice.lastSeenAt`.
8. Sign the access token and reply 200.

## State changes
- Before: one live token row. After: that row has `revokedAt` = the rotation time (kept, it is the reuse evidence), and a new live row exists for the same device.
- Two parallel calls with one token: exactly one gets 200; the other gets `REFRESH_TOKEN_INVALID` (it finds the row rotated a moment ago, so it is the grace case and revokes nothing).
- Idempotency: not replayable. The app must store the new refresh token before the next call.

## Data stored
`DriverRefreshToken` (new row, old row updated), `DriverDevice.lastSeenAt`. **No new column and no migration:** `revokedAt` doubles as the rotation time, which is all reuse detection needs (decision 171). Revoked rows are kept until their device or driver is removed; **cleaning up old rotated rows: TO DECIDE** (one extra row per refresh per driver; they only matter for 30 days).

## Errors
| Code | HTTP status | When it happens | `field` | Message | How the app reacts |
|---|---|---|---|---|---|
| INVALID_INPUT | 400 | Missing, empty or wrong-type `refreshToken` or `deviceId`, bad `deviceId` format, or an unknown field (`details` lists all) | first invalid field | "Please check your input." | Fix the request |
| REFRESH_TOKEN_INVALID | 401 | Unknown, malformed, expired, already rotated, issued to another device, not a driver token | null | "Your session has ended. Please log in again." | Clear stored tokens, start phone login |
| ACCOUNT_BANNED | 403 | The driver is SUSPENDED, BLOCKED or DELETED (all their sessions are deleted) | null | "This account can't book rides." (the registry text) | Show support contact |
| RATE_LIMITED | 429 | More than 120 calls per hour from one IP | null | "Too many requests. Try again shortly." | Retry later |
| INTERNAL_ERROR | 500 | A bug or database failure | null | "Something went wrong. Please try again." | Retry; nothing was written |

## Rate limit, logging and audit
- 120 per IP per hour, in-memory (resets on restart, not shared between instances).
- Log: `requestId`, code, status. Never the token, its hash, ids or the phone. Theft detection should write one structured event once a request context exists (TO DECIDE; no audit table in the MVP, decision 134).

## Edge cases and known limitations
- **One active device.** A driver has one device (`driver-verify-otp.md`, decision 170), so "revoke all sessions" and "revoke this device" are the same set today. The code ends all of the driver's sessions so it stays correct if that rule changes.
- A token replaced by a newer **login on the same device** is also a revoked row: presenting it again after 10 seconds counts as reuse and ends the sessions.
- The 10-second window is a constant (`REFRESH_REUSE_GRACE_MS`, `src/config/tokens.ts`).
- **Known limit (decision 173, with 168):** the guard checks only the token, not the database. After another device logs in, or after a ban or logout, that device's **access** token keeps working until it expires (at most 15 minutes). Only the refresh is cut at once.
- A driver whose refresh token expired (30 days idle) logs in again with an OTP.

## Required tests
Built in `src/modules/driver-auth/driver-session.http.spec.ts` (in-memory) and the real-Postgres cases 26 to 38 of `npm run e2e:rider` (`runbooks/e2e-rider-smoke.md`):
- Success: 200, new access and refresh tokens, old row rotated, new row expires 30 days from the call; rotates many times in a row; works with an expired access token.
- Old token: 401 `REFRESH_TOKEN_INVALID`; within 10 seconds nothing else changes and the new token still works; after 10 seconds every session of the driver is deleted and the new token also fails; another driver is untouched.
- Parallel: 2, 5 and 8 simultaneous calls with one token give exactly one 200.
- Other bad tokens: unknown, malformed, very long, an access token, a rider refresh token, a deleted driver, expired, wrong `deviceId` (nothing revoked, the right device still works).
- Banned: SUSPENDED, BLOCKED and DELETED give 403 `ACCOUNT_BANNED`, all sessions are deleted, a repeat gives 401.
- Input: missing fields, wrong type, unknown field, bad `deviceId`; not served without `/v1`; the 121st call from one IP is 429.
- Second device login kills the first device's refresh; riders are unchanged.

## Changelog
| Date | What changed | Why |
|---|---|---|
| 2026-10-09 | Built (driver only): route, `DriverSessionService`, `REFRESH_TOKEN_INVALID`, reuse detection with a 10-second grace, no migration | M6 driver, owner instruction (decisions 170 to 173) |
