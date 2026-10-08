# GET /v1/driver/me

Status: Draft, written on the owner's instruction of 2026-10-07 (decision 164); **not approved, not built.** Items marked TO DECIDE have no decision yet and must be resolved before the code that needs them is written (CLAUDE.md rule 12).

The path `/v1/driver/me` is as instructed; the controller writes `@Controller('driver')` and never `v1`. Sibling docs: `driver-verify-otp.md`, `rider-me.md` (the JWT guard needs are written there and are the same, with role `DRIVER`).

## Purpose
The driver app calls this after it starts to learn which screen to show. The driver account is already created by `driver-verify-otp.md` (status `DOCUMENTS_PENDING`), so there is no profile step to wait for; the screen choice comes from `status`:

| `status` | App shows |
|---|---|
| `DOCUMENTS_PENDING` | The documents screens (not built, no doc yet) |
| `UNDER_REVIEW` | A "being reviewed" screen |
| `APPROVED` | The home screen |
| `REJECTED` | A "rejected" screen (what happens next: TO DECIDE) |
| `SUSPENDED`, `BLOCKED`, `DELETED` | The support screen |

**The profile-complete flag:** the `Driver` table has no `isProfileComplete` column and no driver profile exists yet, so the reply has **no such flag**. Whether to add one when the driver profile and documents are designed, or to derive it from `status`: TO DECIDE. The app switches on `status` only. The mapping above is the app's; the server only reports the status.

## Who calls it
Driver app. **Protected endpoint:** needs an access token with `role` `DRIVER`. Gate checks: JWT guard (see `rider-me.md`, Gate), throttler (TO DECIDE).

## Request fields
None. No body and no query parameters. The driver is identified only by the token's `sub`; there is no id in the path.

## Response fields
HTTP 200. `data` is `{ driver }`, **the same `driver` object** as in `driver-verify-otp.md` Response fields: `id`, `phoneNumber`, `status`, `createdAt`. No new shape. Never in the reply: `isPhoneVerified`, `lastLoginAt`, `deletedAt`, tokens or hashes.

## Derived values
Read from the `Driver` row. The status is the live database value, not a token claim, so a ban shows at once even though an issued access token still passes the guard for up to 15 minutes (decision 144).

## Order of operations
1. JWT guard: valid token, role `DRIVER`.
2. Throttler guard.
3. Load the Driver by the token's `sub`. No row: `UNAUTHORIZED`.
4. Reply 200 with `driverView(row)`. SUSPENDED, BLOCKED and DELETED drivers are **not** refused (the app needs the status); TO DECIDE as in `rider-me.md`.

## Where it lives (when built)
`src/modules/driver-auth/`: a `me` method in a `driver` controller (`@Controller('driver')`, separate from `driver/auth`, or a new module: TO DECIDE), a method on a service, and the existing `driverView` in `driver-verify-otp.service.ts`.

## Errors
As `rider-me.md`: `UNAUTHORIZED` (bad token, or the driver no longer exists), `FORBIDDEN` (a valid token with role `RIDER`), `RATE_LIMITED` (TO DECIDE), `INTERNAL_ERROR`. Messages are the registry's.

## Rate limit, logging and audit
Rate limit: TO DECIDE. Log: `requestId`, code, status; never the phone or token. No audit event (a read). Admin visibility: driver admin endpoints are still owed (`driver-verify-otp.md`).

## Edge cases and known limitations
- A rider token on this route is `FORBIDDEN`, and a driver token on `GET /v1/rider/me` is `FORBIDDEN`: the `role` claim is the only thing that keeps them apart (decision 158).
- A person who holds both a rider and a driver account uses two logins, one per app.

## Required tests
- Happy path: a new driver gets `DOCUMENTS_PENDING`; after the status is changed in the database the call shows the new status.
- Auth: no token, bad signature, expired and `alg: none` give `UNAUTHORIZED`; a `RIDER` token gives `FORBIDDEN`; a token for a deleted driver id gives `UNAUTHORIZED`.
- Isolation: a driver reads only their own row.
- Shape: exactly `id`, `phoneNumber`, `status`, `createdAt`, `createdAtIst`; no profile flag.
- Envelope: standard envelope, served only under `/v1`.

## Changelog
| Date | What changed | Why |
|---|---|---|
| 2026-10-07 | Draft created (not built); no profile flag because the Driver has none | Owner instruction of 2026-10-07 (decision 164) |
