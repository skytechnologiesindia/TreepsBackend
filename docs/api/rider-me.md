# GET /v1/rider/me

Status: Draft, written on the owner's instruction of 2026-10-07 (decision 164); **not approved, not built.** Items marked TO DECIDE have no decision yet and must be resolved before the code that needs them is written (CLAUDE.md rule 12).

The path `/v1/rider/me` is as instructed; the controller writes `@Controller('rider')` and never `v1`. Sibling docs: `rider-verify-otp.md`, `rider-register.md`, `driver-me.md`.

## Purpose
The rider app calls this after it starts (and after a failed or lost `register` reply) to learn which screen to show. It returns the rider, and the app reads `status` and `isProfileComplete`:

| `status` | `isProfileComplete` | App shows |
|---|---|---|
| `PROFILE_PENDING` | false | The profile screen (`POST /v1/rider/auth/register`) |
| `ACTIVE` | true | The home screen |
| `SUSPENDED`, `BLOCKED`, `DELETED` | any | The support screen (the app must not book rides) |

The mapping is the app's; the server only reports the two fields. The server never sends "which screen".

## Who calls it
Rider app. **Protected endpoint:** needs an access token with `role` `RIDER`. Gate checks: JWT guard, throttler (TO DECIDE: the limit; a read call, so likely higher than the write routes).

## Request fields
None. No body and no query parameters. A body or a query string is ignored (TO DECIDE: reject unknown query keys with `UNKNOWN_FIELD`, as `input-validation.md` does for bodies). The rider is identified only by the `sub` claim of the token; there is no id in the path, so a rider can never read another rider.

## Response fields
HTTP 200. `data` is `{ rider }`, **the same `rider` object** as in `rider-register.md` Response fields (id, fullName or null, phoneNumber, email or null, registeredCity, registeredState, status, isPhoneVerified, isEmailVerified, isProfileComplete, createdAt). No new shape. Never in the reply: `deletedAt`, `lastLoginAt`, tokens or hashes.

## Derived values
Everything is read from the `Rider` row. The status shown is the live database value, not a claim in the token, so a ban shows here at once even though an already-issued access token still passes the guard for up to 15 minutes (decision 144).

## Order of operations
1. JWT guard: valid token, role `RIDER`.
2. Throttler guard.
3. Load the Rider by the token's `sub`. No row: `UNAUTHORIZED` (the token belongs to a rider that no longer exists).
4. Reply 200 with `riderView(row)`. A SUSPENDED, BLOCKED or DELETED rider is **not** refused here: the app needs to read the status to show the support screen (TO DECIDE: confirm; the alternative is `ACCOUNT_BANNED`).

## Where it lives (when built)
`src/modules/rider-auth/`: a `me` method in `rider-auth.controller.ts` (`@Controller('rider')` is a second controller, or the route sits in a new `rider-profile` module: TO DECIDE), a small `rider-me.service.ts` or a method on an existing service, and the existing `rider-view.ts`.

## Gate: what the JWT guard needs (decision 165)
The guard is new; nothing in the code verifies an access token today (only `AccessTokenService` signs, `src/common/jwt/`).
- **Verify:** HS256 only (never `none` or another algorithm), signature with `JWT_ACCESS_SECRET`, `exp` in the future (injectable clock), `iss` equal to `treeps`, and `sub`, `role`, `deviceId` present and strings. `verifyHs256Jwt(token, secret, nowSeconds)` already exists in `src/common/jwt/hs256-jwt.ts`; the guard calls it and then checks `iss`, `role`, `sub` and `deviceId` itself (whether it also checks `iss` is not known from reading only the doc: confirm when the guard is written).
- **Role per route:** a decorator (for example `@Roles('RIDER')`) names the role the route accepts. A valid token with another role is `FORBIDDEN`; a missing or bad token is `UNAUTHORIZED`. This is the check decision 158 reserved: a driver token must never open a rider route.
- **Principal:** the guard puts `{ id, role, deviceId }` on the request, and a parameter decorator (for example `@CurrentUser()`) hands it to the controller. Controllers never use `@Res()` or raw `@Req()` for this (rule 13).
- **Public routes:** the existing routes (send-otp, verify-otp, refresh, logout, and the estimate route if it is public) must stay open. If the guard is registered globally with `APP_GUARD`, they need an `@Public()` marker; if it is attached per route with `@UseGuards`, they need nothing. Which one: TO DECIDE (TRACKER notes the test modules must import the same guard setup either way).
- **No database call in the guard** in the MVP (stateless, decision 144). The route reads the row itself.
- **Errors** come from the existing registry (`UNAUTHORIZED` 401, `FORBIDDEN` 403); the message never says why the token failed.

## Errors
| Code | HTTP status | When it happens | `field` marker | Rider-safe message | How the app UI should react |
|---|---|---|---|---|---|
| UNAUTHORIZED | 401 | Missing, malformed, wrongly signed or expired token; the rider no longer exists | null | "Please log in again." | Try `refresh`; if that fails, start phone login again |
| FORBIDDEN | 403 | A valid token whose `role` is not `RIDER` | null | "You don't have access to this." | Treat as a bug; log out |
| RATE_LIMITED | 429 | Over the limit (TO DECIDE) | null | "Too many requests. Try again shortly." | Retry later |
| INTERNAL_ERROR | 500 | A bug or database failure | null | "Something went wrong. Please try again." | Show retry |

## Rate limit, logging and audit
Rate limit: TO DECIDE. Log: `requestId`, code, status; never the phone, name, email or token. No audit event (a read).

## Edge cases and known limitations
- The access token stays valid for up to 15 minutes after a ban; this route still shows the live status.
- `isProfileComplete` and `status` can disagree only if a row is edited by hand; the app switches on `status` first.
- No caching headers (TO DECIDE).

## Required tests
- Happy path: a `PROFILE_PENDING` rider gets `status` `PROFILE_PENDING`, `isProfileComplete` false, `fullName` null; after `register` the same call gives `ACTIVE` and true.
- Auth: no token, bad signature, expired, `alg: none` give `UNAUTHORIZED`; a `DRIVER` token gives `FORBIDDEN`; a token for a deleted rider id gives `UNAUTHORIZED`.
- Isolation: a rider reads only their own row (two riders, two tokens).
- Banned: SUSPENDED, BLOCKED and DELETED riders get 200 with their status (if the TO DECIDE above is confirmed).
- Shape: the `rider` object is exactly the same fields as in `verify-otp`; no `deletedAt`, `lastLoginAt` or token in the reply.
- Envelope: standard envelope, served only under `/v1`.

## Changelog
| Date | What changed | Why |
|---|---|---|
| 2026-10-07 | Draft created (not built); JWT guard needs written down | Owner instruction of 2026-10-07 (decisions 164 and 165) |
