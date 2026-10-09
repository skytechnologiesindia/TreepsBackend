# POST /v1/driver/auth/logout

Status: BUILT 2026-10-09 on the owner's instruction (M6, driver only; decisions 170 to 173). Items marked TO DECIDE have no decision yet. A change after approval needs a changelog row. **The rider logout (`rider-logout.md`) is not built and not changed by this doc; riders stay deferred.**

The controller writes `@Controller('driver/auth')` and never `v1`. Sibling docs: `driver-verify-otp.md`, `driver-refresh.md`, `rider-logout.md` (the rider design, deferred).

## Purpose
The driver logs out on this device. The server deletes that device's session (the `DriverDevice` row and all its refresh tokens) so no refresh token of it can be exchanged again, and its push token is forgotten.

## Who calls it
Driver app, from the logout button. **Public route:** the refresh token is the credential, so it works with an expired access token. No JWT guard.

## Request fields
Body, JSON. Nothing else is accepted; unknown fields are `UNKNOWN_FIELD`.

| Name | Type | Unit | Required? | Allowed range | Why it exists | Why this type/unit | Bucket | What breaks if wrong |
|---|---|---|---|---|---|---|---|---|
| refreshToken | string | opaque text | Required | 1 to 512 characters, no U+0000. Any non-empty string is accepted: an unknown or malformed one is still a 200. A missing value, `""` or a non-string is `INVALID_INPUT` | Identifies which device's session to end and proves the caller holds it | Opaque random value | Identity | Anyone could log out anyone |

## Response fields
Success: **HTTP 200**, `data` is `{ loggedOut: true }`. The reply is identical whether or not the token was known, so the call cannot be used to test tokens. No date-time field.

## Order of operations
1. Throttler guard (IP): 120 per IP per hour (decision 137), counter name `driver-logout`.
2. Validate the body.
3. Hash the token and look up the `DriverRefreshToken` row by `tokenHash`. **Any** row counts, including an already-rotated or expired one: it still names a device.
4. If found: in one transaction delete every `DriverRefreshToken` row of that `(driverId, deviceId)` and then the `DriverDevice` row. If not found: nothing.
5. Reply 200 `{ loggedOut: true }`.

## State changes
Before: a device with its tokens. After: none of them. **Idempotent:** calling again, or with an unknown token, changes nothing and still gives 200. After logout a refresh with that token is `REFRESH_TOKEN_INVALID`. The access token already issued keeps working until it expires (max 15 minutes, decision 173).

## Errors
| Code | HTTP status | When it happens | `field` | Message | How the app reacts |
|---|---|---|---|---|---|
| INVALID_INPUT | 400 | Missing, empty or wrong-type `refreshToken`, or an unknown field | first invalid field | "Please check your input." | Fix the request |
| RATE_LIMITED | 429 | More than 120 calls per hour from one IP | null | "Too many requests. Try again shortly." | Retry later |
| INTERNAL_ERROR | 500 | A bug or database failure | null | "Something went wrong. Please try again." | Retry |

## Edge cases and known limitations
- Someone holding an old, already-rotated token of the device can log that device out. They would need the secret 256-bit value, so this is no weaker than holding the live token.
- Logout leaves the driver's other data alone (the `Driver` row, status, documents). Because a driver has one device, logout normally leaves no session at all.
- Log: `requestId`, status. Never the token or its hash.

## Required tests
Built in `src/modules/driver-auth/driver-session.http.spec.ts` and e2e cases 35 and 36: 200 `{ loggedOut: true }` with no Authorization header; the device and token rows are gone and refresh then gives 401; repeat, unknown, garbage, rotated-token and other-driver cases; missing or non-string token is 400; unknown field is `UNKNOWN_FIELD`.

## Changelog
| Date | What changed | Why |
|---|---|---|
| 2026-10-09 | Built (driver only): route, idempotent session delete | M6 driver, owner instruction (decisions 170 to 173) |
