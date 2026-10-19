# POST /v1/rider/auth/logout

Status: BUILT 2026-10-09 on the owner's instruction (server-side sessions, decisions 174 to 178). Replaces the earlier refresh-token design (APPROVED 2026-10-05). Items marked TO DECIDE have no decision yet. A change after approval needs a changelog row.

The controller writes `@Controller('rider/auth')` and never `v1`. Sibling docs: `rider-verify-otp.md`, `rider-register.md`, `driver-logout.md`.

## Purpose
The rider logs out on this device. The server deletes this device's session, so the token stops working at once. Other devices of the same rider keep their sessions (rider single-device is TO DECIDE, decision 177).

## Who calls it
Rider app, from the logout button. **Protected route:** it needs the session token (`Authorization: Bearer <token>`) of the session being ended. Gate checks: session guard (token known and unexpired, role `RIDER`, account not banned), throttler guard (IP), nothing else. There is no body.

## Request fields
None. The route reads no body and no query. The rider id and the device id come from the session, never from the request.

## Response fields
Success: **HTTP 200**, `data` is `{ loggedOut: true }`.

## Order of operations
1. Session guard: `UNAUTHORIZED` (no token, unknown token, expired), `FORBIDDEN` (a driver session), `ACCOUNT_BANNED` (and all sessions of the rider are deleted).
2. Throttler guard (IP): 120 per IP per hour (decision 137), counter name `rider-logout`. (The guard runs first, so a refused token does not use up the limit.)
3. Delete the session of this rider and device (`SessionService.deleteForDevice`).
4. Reply 200 `{ loggedOut: true }`.

## State changes
Before: one session row for the device. After: none. **Not idempotent in the sense of the old design:** calling again with the same token is `UNAUTHORIZED` (401), like any guarded route, because the token is gone. The `Device` row (and its push token) is kept.

## Errors
| Code | HTTP status | When it happens | `field` | Message | How the app reacts |
|---|---|---|---|---|---|
| UNAUTHORIZED | 401 | No `Authorization: Bearer` header, an unknown or expired token (including one already logged out) | null | "Please log in again." | Treat as logged out: clear the stored token |
| FORBIDDEN | 403 | A driver session | null | "You don't have access to this." | Treat as a bug |
| ACCOUNT_BANNED | 403 | The rider is SUSPENDED, BLOCKED or DELETED (all their sessions are deleted) | null | "This account can't book rides." | Show support contact |
| RATE_LIMITED | 429 | More than 120 calls per hour from one IP | null | "Too many requests. Try again shortly." | Retry later |
| INTERNAL_ERROR | 500 | A bug or database failure | null | "Something went wrong. Please try again." | Retry |

## Edge cases and known limitations
- An app that gets 401 on logout can simply clear its token: the session is already gone.
- Log: `requestId`, status. Never the token or its hash.

## Required tests
Built in `register.http.spec.ts` (logout group), `driver-session.http.spec.ts` and e2e cases 32 and 33: 200 `{ loggedOut: true }`; the token is dead afterwards (401 on logout and on register); no token and unknown token are 401; a driver token is 403; only this device's session is deleted; a banned rider is 403 with sessions deleted.

## Changelog
| Date | What changed | Why |
|---|---|---|
| 2026-10-05 | Draft APPROVED (refresh-token logout, public, always 200) | Rider auth docs-first |
| 2026-10-09 | **Redesigned and built:** guarded by the session token, no body, 401 for an unknown token, deletes the device session | Server-side sessions (decisions 174 to 178) |
| 2026-10-10 | Logout also deletes this device's `Device` row (session and device row in one transaction), so the device's `fcmToken` dies with the session; the reply is unchanged | Owner instruction of 2026-10-10 (decision 179) |
