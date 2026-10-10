# POST /v1/driver/auth/logout

Status: BUILT 2026-10-09 on the owner's instruction (server-side sessions, decisions 174 to 178). Replaces the refresh-token logout built earlier the same day. Items marked TO DECIDE have no decision yet. A change after approval needs a changelog row.

The controller writes `@Controller('driver/auth')` and never `v1`. Sibling docs: `driver-verify-otp.md`, `rider-logout.md`.

## Purpose
The driver logs out on this device. The server deletes this device's session, so the token stops working at once. A driver has one active session (decision 174), so this normally leaves no session at all.

## Who calls it
Driver app, from the logout button. **Protected route:** it needs the session token (`Authorization: Bearer <token>`). Gate checks: session guard (token known and unexpired, role `DRIVER`, account not banned), throttler guard (IP). There is no body.

## Request fields
None. The route reads no body and no query. The driver id and the device id come from the session.

## Response fields
Success: **HTTP 200**, `data` is `{ loggedOut: true }`. No date-time field.

## Order of operations
1. Session guard: `UNAUTHORIZED` (no token, unknown token, expired), `FORBIDDEN` (a rider session), `ACCOUNT_BANNED` (and all sessions of the driver are deleted).
2. Throttler guard (IP): 120 per IP per hour (decision 137), counter name `driver-logout`. The guard runs first, so a refused token does not use up the limit.
3. Delete the session of this driver and device (`SessionService.deleteForDevice`).
4. Reply 200 `{ loggedOut: true }`.

## State changes
Before: the driver's session row. After: none. Calling again with the same token is `UNAUTHORIZED` (401), like any guarded route. The `DriverDevice` row (and its push token) is kept.

## Errors
| Code | HTTP status | When it happens | `field` | Message | How the app reacts |
|---|---|---|---|---|---|
| UNAUTHORIZED | 401 | No `Authorization: Bearer` header, an unknown or expired token (including one already logged out, or replaced by a login on another phone) | null | "Please log in again." | Treat as logged out: clear the stored token |
| FORBIDDEN | 403 | A rider session | null | "You don't have access to this." | Treat as a bug |
| ACCOUNT_BANNED | 403 | The driver is SUSPENDED, BLOCKED or DELETED (all their sessions are deleted) | null | "This account can't book rides." | Show support contact |
| RATE_LIMITED | 429 | More than 120 calls per hour from one IP | null | "Too many requests. Try again shortly." | Retry later |
| INTERNAL_ERROR | 500 | A bug or database failure | null | "Something went wrong. Please try again." | Retry |

## Edge cases and known limitations
- A driver who logs in on another phone has already lost this session, so a later logout here is 401. The app clears its token.
- Log: `requestId`, status. Never the token or its hash.

## Required tests
Built in `driver-session.http.spec.ts` and e2e cases 27 to 29 and 33: 200 `{ loggedOut: true }` in the envelope; the token is dead afterwards; no token, unknown token 401; a rider token 403; a banned driver 403 with the session deleted; a login on a second phone kills the first phone's session at once.

## Changelog
| Date | What changed | Why |
|---|---|---|
| 2026-10-09 | Built as a public refresh-token logout (always 200) | M6 driver (decisions 170 to 173) |
| 2026-10-09 | **Redesigned:** guarded by the session token, no body, 401 for an unknown token | Server-side sessions (decisions 174 to 178) |
| 2026-10-10 | Logout also deletes this device's `DriverDevice` row (session and device row in one transaction), so the device's `fcmToken` dies with the session; the reply is unchanged | Owner instruction of 2026-10-10 (decision 179) |
