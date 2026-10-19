# POST /v1/admin/auth/login

Status: BUILT 2026-10-16 on the owner's instruction (decision 188), with the proposals below as written. Items marked TO DECIDE have no decision yet. The migration is applied to scratch databases only, not to `treeps_db`.

## Purpose

The admin logs in with an email and a password and gets a session token. The admin screens send that token on every admin call (`Authorization: Bearer <token>`). This is the first admin route, so it also creates the admin account model that the later admin routes (driver submissions now, approve and reject next) all depend on.

## Who calls it

The admin web panel. No token is needed to call it. Every other `/v1/admin/...` route needs the token from this one, and a driver or rider token is refused there.

## How admins are created

There is no sign-up route. An admin is created by a one-time script run on the server (`npm run admin:create -- <email> <name words>`, for example `npm run admin:create -- asha@treeps.in Asha Verma`; the name is every word after the email, so no quotes are needed. The password is typed at a hidden prompt, or piped in on stdin, and is never put in a command line, a log or a file). Reason: nobody can make themselves an admin through the API.

## Request fields

| Name | Type | Required? | Rule | Why it exists |
|---|---|---|---|---|
| email | string | Required | Valid email, lower-cased by the server, at most 254 characters | Identifies the admin |
| password | string | Required | 1 to 128 characters. Not trimmed. The strength rule applies only when the script creates the password: at least 12 characters (TO DECIDE) | The secret |

Unknown fields are refused with `INVALID_INPUT`.

## Response fields

```json
{
  "success": true,
  "data": {
    "admin": { "id": "uuid", "name": "Asha Verma", "email": "asha@treeps.in" },
    "tokens": { "accessToken": "opaque token", "expiresInSeconds": 2592000 }
  }
}
```

The password hash is never returned. The token is shown once, here.

## State changes

- Checks the password against the stored hash (scrypt, a slow hash built into Node, so no new package; TO DECIDE if you prefer argon2 or bcrypt as a package).
- Creates a session in the `AdminSession` table (not the rider and driver session store). Logging in again replaces the earlier session of that admin, so an admin has one session at a time.
- Sets `lastLoginAt` on the admin.
- A wrong email and a wrong password give the same answer and take the same time, so nobody can learn which admin emails exist.

## Data stored

New table `Admin`: `id`, `email` (unique), `name`, `passwordHash`, `isActive` (default true), `lastLoginAt`, `createdAt`, `updatedAt`. Sessions are in a third table `AdminSession` (`id`, `tokenHash`, `adminId`, `expiresAt`, `createdAt`), the same shape as the driver one, so nothing existing changed. 30 days, sliding. Migration `20261016170000_admin`.

## Errors

| Code | HTTP | When | Message |
|---|---|---|---|
| INVALID_INPUT | 400 | A field is missing, wrong type or the email is malformed | Per `input-validation.md` |
| UNAUTHORIZED | 401 | Wrong email or password, or the admin is not active. Same answer for all three. | Please log in again. |
| RATE_LIMITED | 429 | Too many tries | Please wait and try again. |

## Rate limit, logging and audit

- Rate limit: 10 tries per hour per IP (TO DECIDE; a proposal). **A per-email limit was not built:** the rate limiter supports only IP and phone counters, so a limit per email needs a change to the limiter. A login brute force is the main risk of this route. TO DECIDE.
- The password and the token are never logged.
- Audit: login attempts are NOT logged yet (only `lastLoginAt` is saved). TO DECIDE: a login audit log or table.

## Tests (built)

`src/modules/admin/password.spec.ts` and `src/modules/admin/admin.pg.spec.ts` (real Postgres, `RUN_PG_TESTS=1`, scratch database `treeps_scratch_admin`). A live simulation also ran against the running server. They cover:


Happy path. Wrong password. Unknown email (same answer as wrong password). Inactive admin. Missing or extra field. Rate limit. A rider or driver token refused on an admin route. A second login replaces the first session. A switched-off admin loses the token at once.

## Changelog

| Date | What changed | Why |
|---|---|---|
| 2026-10-16 | Draft created | Owner asked for an admin view of driver submissions; admin login is chosen as email and password with an Admin table |
| 2026-10-16 | Built. Status BUILT; create script takes the name as unquoted words; per-email limit not built (limiter supports IP and phone only); `AdminSession` table chosen | Owner told Claude to build and simulate it |
