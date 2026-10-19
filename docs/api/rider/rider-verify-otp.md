# POST /v1/rider/auth/verify-otp

Status: APPROVED (owner, 2026-10-05). Items still marked TO DECIDE must be resolved in this doc before the code that needs them is written (CLAUDE.md rule 12). A change after approval needs a changelog row. **Redesigned 2026-10-07 (decisions 162 to 165): a new phone now gets a Rider row and real tokens here; there is no registration token. Built 2026-10-08 (this route only; the old register route is replaced in the next step).**

Part of the unified phone-OTP flow (see the diagram in `rider-send-otp.md`). The path `/v1/rider/auth/verify-otp` is APPROVED; the controller writes `@Controller('rider/auth')` and never `v1`.

## Purpose
The rider types the code they received. The server checks it with the OTP provider. If the phone has no rider, **the server creates the Rider** (status `PROFILE_PENDING`, phone verified, no name or email, `isProfileComplete` false) and logs them in. If the phone has a rider who is `ACTIVE` or `PROFILE_PENDING`, this is a login. In both cases the reply has the same shape: `isNewRider`, the rider and real tokens. The profile is finished later with `POST /v1/rider/auth/register` (`rider-register.md`), possibly days later. A SUSPENDED, BLOCKED or DELETED rider is refused.

## Who calls it
Rider app, after `send-otp`. Public endpoint (no token, no role; an explicit exception to the gate in `api-standard.md` section 1). The Rider role is attached to the token this API issues. Gate checks: validation, per-phone limit, OTP.

## Request fields
Body, JSON. Nothing else is accepted; unknown fields (including `status`, `role`, `purpose`) are rejected with `UNKNOWN_FIELD`. Nothing is trimmed, lowercased or defaulted silently.

| Name | Type | Unit | Required? | Allowed range | Why it exists | Why this type/unit | Bucket | What breaks if wrong |
|---|---|---|---|---|---|---|---|---|
| phoneNumber | string | E.164 text | Required | `+91` + 10 digits, first of the 10 in 6 to 9 (same rule as `send-otp`) | Finds the OTP session and the rider | One canonical spelling per number | Identity | Wrong session or account |
| otp | string | digits as text | Required | Exactly 6 characters, digits 0 to 9 only | Proves the rider holds the phone | Text, not a number: a leading zero must survive (`012345`) | Input | A number type would drop the leading zero and fail a real rider |
| device | object | n/a | Required | Fields below; no unknown fields at any depth | Lets the server bind tokens to one device | Nested object | Input | Tokens cannot be bound to a device |
| device.deviceId | string | text | Required | 1 to 64 characters, only `A-Z a-z 0-9 _ -` (decision 132) | App-generated install id; one session per device | Text | Identity | Two devices share one session |
| device.platform | string | enum | Required | Exactly `ANDROID` or `IOS` (uppercase). The field name is `platform` (an earlier draft renamed it to `devicePlatform`; that was reverted, decision 181) | Admin and push routing; shown to support | Enum, uppercase | Input | Wrong push channel |
| device.appVersion | string | text | Required | 1 to 20 characters from `A-Z a-z 0-9 . + _ -` (pattern `^[0-9A-Za-z.+_-]{1,20}$`), so `1.4.2`, `1.4.2+37` and `2.0.0-beta.1` all pass. Not trimmed; `""` is `TOO_SHORT`, 21 characters is `TOO_LONG`, any other character is `INVALID_FORMAT` (decision 181, replaces decision 143) | Support and force-update | Text | Input | Cannot tell which build has a bug |
| device.fcmToken | string | text | Optional (omitted, `null` and `""` all mean "not sent") | At most 512 characters, no whitespace of any kind and no NUL. A token with a space or over 512 characters is `INVALID_FORMAT` / `TOO_LONG`. **The value is sensitive: never logged, never returned in any reply, never put in an error detail** (details carry the field name only) | Push notifications | Text | Input | No push messages |

`device.*` uses the dot-path field names of `input-validation.md` section 4. The `device` shape is the same in the driver route (`driver-verify-otp.md`; one DTO class).

**The exact body (breaking change for the apps, 2026-10-10: `appVersion` rule loosened, `fcmToken` may be null or empty, `platform` stays `platform`):**

```json
{
  "phoneNumber": "+919477172214",
  "otp": "123456",
  "device": {
    "deviceId": "a1b2c3d4-install-id",
    "platform": "ANDROID",
    "appVersion": "1.4.2+37",
    "fcmToken": "optional push token, omit it or send null when the user denied notifications"
  }
}
```

`device.platform` and `device.appVersion` are required on every call. `device.fcmToken` is the only optional device field.

**What is stored from `device` (rider and driver the same, decision 181):** one row per install, on the table that already held `deviceId` (`Device` for riders, `DriverDevice` for drivers): `deviceId`, `platform`, `appVersion`, `fcmToken` (nullable) and `lastSeenAt`. **Every successful verify-otp refreshes that row** (an upsert on `(accountId, deviceId)`, so there is never a duplicate): `platform`, `appVersion` and `lastSeenAt` are always overwritten; `fcmToken` is overwritten only when a non-empty token is sent, so a login without a token (omitted, `null` or `""`) never wipes a stored one. Nothing from `device` is validated and then thrown away. The device fields are **not** on the Rider or Driver table and are **never returned** in a reply. **Logout deletes the device row together with the session (decision 179), so the push token dies with the session.** Known limit: a session that expires or is deleted by a ban leaves its device row (and token) until the next login of that device; cleanup is TO DECIDE.


Shared types (`input-validation.md` section 2b): `IndianMobile`, `OtpCode`, `DeviceId`, `AppVersion`, `FcmToken`, `OneOf` for `platform`.

## Response fields
Success: HTTP 200 in both cases (TO DECIDE: a new rider row is created, so 201 would also fit; 200 is kept because a controller cannot pick the status per case without raw response access, rule 13, and the driver route does the same, decision 156). The app switches on `status` and `isProfileComplete` (or calls `GET /v1/rider/me`, `rider-me.md`); `isNewRider` only says whether this call created the account. **One shape for a new and an existing rider.** `data`:

| Name | Type | Unit | Required? | Allowed range | Why it exists | Why this type/unit | Bucket | What breaks if wrong |
|---|---|---|---|---|---|---|---|---|
| isNewRider | boolean | n/a | Always | `true` if this call created the Rider; `false` for an existing rider (also one still `PROFILE_PENDING` from an earlier call) | Lets the app show a welcome | Boolean | Derived | App shows the wrong greeting |
| rider | object | n/a | Always | Same fields as `rider` in `rider-register.md` Response fields, including `registeredAddress`, `termsAcceptedAt` (+ `termsAcceptedAtIst`) and `termsVersion` (all `null` until the profile is completed; `fullName` and `email` are null and `status` is `PROFILE_PENDING` until then). There is no `gender` (decision 184) | App shows the rider and picks its screen | Same object everywhere | Derived | Inconsistent profile |
| tokens | object | n/a | Always | exactly `{ accessToken, expiresInSeconds }`. `accessToken` is the opaque **session token**: 43 base64url characters (32 random bytes), shown once, only its SHA-256 hash is stored. `expiresInSeconds` is `2592000` (30 days, sliding: extended on use, written at most once an hour) | The credential for later calls (`Authorization: Bearer <accessToken>`) and how long it lasts | Opaque random value, so the server can delete it at once; the name `accessToken` is kept so the apps do not change | Derived | The app cannot call protected routes |

Every date-time in `rider` also has its Indian-time twin (`rider.createdAtIst`, for example `"07-10-2026 19:23:10"`), added by the central serializer step of `response-format.md` section 8; it is additive.

There is **no** `registrationToken`, no `registrationTokenExpiresInSeconds` and no top-level `profileComplete`: the profile flag is `rider.isProfileComplete`.

Never in the reply: the provider session id, `attempts`, any token hash, the rider's `deletedAt` or `lastLoginAt`, or any device field (`platform`, `appVersion`, `fcmToken`).

## Order of operations
1. Validate the body.
2. **Per-phone limit (decision 121):** at most 10 verify attempts per phone per hour, counted from the `attempts` of that phone's `OtpSession` rows created in the last hour, so the count survives a restart and works across instances. Over the limit: `RATE_LIMITED`, no provider call. There is no per-IP limit on this route in the MVP.
3. Load the newest `OtpSession` for this phone **with purpose `RIDER_AUTH`** (a driver session for the same phone is never used and its attempts do not count toward the limit above):
   - none, or already used (`verifiedAt` set): `OTP_INVALID`;
   - `expiresAt` passed: `OTP_EXPIRED`;
   - `attempts` already 5: `OTP_ATTEMPTS_EXCEEDED`.
4. **Reserve one attempt atomically**: one conditional update (`attempts + 1` where `attempts < 5`, `verifiedAt` is null and not expired). If no row changed, another request got there first: re-read and return the right code from step 3. Why: twenty parallel guesses must not all pass the check before any is counted.
5. Ask the OTP provider to verify (5 s timeout, no retry, never inside a DB transaction).
   - Provider failure: give the attempt back, reply `OTP_PROVIDER_ERROR`.
   - `MISMATCH`: keep the attempt, reply `OTP_INVALID`. After the 5th wrong code the next call gets `OTP_ATTEMPTS_EXCEEDED`.
6. Look up the Rider by phone. Only now, after the caller proved they hold the phone, does the account state matter.
7. Mark the code used (the **single-use** step: `verifiedAt` null becomes now; if it matches no row, another request used it first: `OTP_INVALID`). What else happens depends on the account:
   - **No rider:** one database transaction (as the driver route, decision 156): the conditional update marks the code used and finished (`verifiedAt` and `consumedAt`); create the Rider (`PROFILE_PENDING`, `isPhoneVerified` true, `isProfileComplete` false, `fullName` and `email` null, `lastLoginAt` now); create the Device; create the first session through `SessionService` (a `RefreshToken` row; SHA-256 hash only). A unique violation on the phone (another session created the Rider first) becomes `CONFLICT`; the whole transaction rolls back, so the code is not used. Reply `isNewRider` true.
   - **ACTIVE or PROFILE_PENDING:** a separate conditional update marks `verifiedAt` first, then one database transaction: upsert the `Device` (create it, or update `platform`, `appVersion` and `lastSeenAt`, and `fcmToken` only when a non-empty one is sent); replace this device's session with a new one through `SessionService` (SHA-256 hash only; the rider's other devices keep theirs, decision 177); set `Rider.lastLoginAt` to now (**on every successful verify-otp**, new account or login); set the session's `consumedAt`. Reply `isNewRider` false.
   - **SUSPENDED, BLOCKED or DELETED:** set `consumedAt`, reply `ACCOUNT_BANNED`. No tokens. A DELETED row keeps owning its phone (plain unique, decision 128), so the phone cannot register again. Revisit when a delete or restore flow is built.

## Derived values
- `isNewRider`, the rider object and the tokens are computed by the server. The client sends no status or role.
- Session token: 32 random bytes from `crypto.randomBytes`, base64url (43 characters), valid 30 days from the last use (sliding: `expiresAt` is moved to now + 30 days by the session guard, at most once an hour). Only its SHA-256 hash is stored, in the `RefreshToken` table reused as the session table (no migration, decision 174). There is no JWT, no refresh token and no signing secret.

## Reference data used
OTP numbers and provider timeout as in `rider-send-otp.md`. Session lifetime 2592000 seconds and the hourly write interval are constants in `src/config/tokens.ts`. New environment variables need a rule in `input-validation.md` section 6 and a line in `.env.example` in the same commit.

## State changes
- Before: one open `OtpSession`. After (existing rider): `verifiedAt` and `consumedAt` set, one `Device` row (new or updated), one new session (the old one for that device deleted), `Rider.lastLoginAt` updated. After (new phone): `verifiedAt` and `consumedAt` set, one new `Rider` (`PROFILE_PENDING`), one `Device`, one `RefreshToken`.
- Idempotency: natural, not replayable. The code is single use, so a repeated call gets `OTP_INVALID`. If the reply is lost, the rider asks for a new code. No `Idempotency-Key` header in the MVP.
- Concurrency: the conditional attempt update and the conditional `verifiedAt` update make exactly one concurrent request win. Two devices logging in at once get separate `Device` rows (unique `(riderId, deviceId)`).
- **New phone:** marking the code used and creating the Rider, Device and RefreshToken are one transaction (step 7). If it fails, nothing is written and the rider can try the same code again (the attempt stays counted). Two simultaneous verifies for a new phone create exactly one Rider: the loser gets `OTP_INVALID` (code already used, if the other session is the same) or `CONFLICT` (a different session created the Rider first).
- **ACTIVE rider (login):** if the transaction in step 7 fails after the code was marked used, the code is already used and the rider asks for a new one. Accepted: marking and issuing are not combined here. Combining them is TO DECIDE.

## Data stored
`OtpSession` (updated), `Rider` (created for a new phone), `Device`, `RefreshToken` (hash only), `Rider.lastLoginAt`. The OTP and the provider session id are never in a reply or log. No limit on devices per rider in the MVP (decision 144).

## Errors
All errors use the envelope in `standards/response-format.md`.

| Code | HTTP status | When it happens | `field` marker | Rider-safe message | How the app UI should react |
|---|---|---|---|---|---|
| INVALID_INPUT | 400 | Missing, wrong type, wrong format or unknown field at any depth (`details` lists all) | first invalid field | "Please check your input." | Highlight the fields in `details` |
| OTP_INVALID | 422 | No usable session, an already-used session, or a wrong code | otp | "That code is not right. Please check and try again." (proposed) | Let the rider retype or resend |
| OTP_EXPIRED | 422 | The newest session is older than 5 minutes | otp | "That code has expired. Please ask for a new one." (proposed) | Show "send a new code" |
| OTP_ATTEMPTS_EXCEEDED | 429 | 5 wrong codes already used on this session | otp | "Too many wrong codes. Please ask for a new code." (proposed) | Force "send a new code" |
| ACCOUNT_BANNED | 403 | The rider is SUSPENDED, BLOCKED or DELETED | null | "This account can't book rides." (proposed in `estimate.md`; the same wording is used for login, decision 144) | Show support contact |
| OTP_PROVIDER_ERROR | 503 | The provider timed out, refused, or sent an unreadable reply | null | "We couldn't reach the code service. Please try again." (proposed) | Show retry; the attempt was not used |
| RATE_LIMITED | 429 | More than 10 verify attempts for this phone in the last hour | null | "Too many requests. Try again shortly." | Disable the button briefly |
| CONFLICT | 409 | Another session created this phone's Rider at the same moment (rare); the code is not used | null | "This can't be done right now. Please refresh and try again." | Ask for a new code; the next verify logs in |
| INTERNAL_ERROR | 500 | A bug or a database failure | null | "Something went wrong. Please try again." | Show retry |

## Where it lives
`src/modules/rider-auth/`: `verify-otp.service.ts` (the order of operations above), `src/modules/otp/dto/verify-otp.dto.ts` and `device.dto.ts` (shared with the driver route; the shared types `IndianMobile`, `OtpCode`, `DeviceId`, `AppVersion`, `OneOf`, `Text`, `Nested`), `src/common/session/session.service.ts` (`SessionService`, shared with the driver route), `rider-view.ts` (the `rider` object), and the route in `rider-auth.controller.ts`. The session token comes from `newOpaqueToken` in `src/common/tokens.ts` (Node's `crypto`, no library). The time comes from the injectable clock (`src/common/clock.ts`).

The service reads only sessions with purpose `RIDER_AUTH` (both for finding the newest session and for the 10-per-hour count), so a driver code for the same phone can never log a rider in, and driver attempts do not count toward the rider limit.

## Race tests (real Postgres)
`src/modules/rider-auth/verify-otp.pg.spec.ts`, skipped unless `RUN_PG_TESTS=1`, so `npm test` stays database-free. It uses only the scratch database `treeps_scratch_rider_verify` (a constant in `testing/scratch-db.ts`; only host, port, user and password come from `DATABASE_URL`, so it can never open `treeps_db`).
```
$env:RUN_PG_TESTS = '1'; npx vitest run src/modules/rider-auth/verify-otp.pg.spec.ts
```
A barrier holds both requests until each has passed the code check and the rider lookup, so the race happens inside the transaction. Ten rounds: exactly one `OK`, the other `OTP_INVALID`, one Rider per phone. A second test makes the lookup answer "no rider" while a Rider already holds the phone: the reply is `CONFLICT`, nothing is written and the code is still unused.

## Rate limit, logging and audit
- Rate limit (decision 121): 10 verify attempts per phone per hour, on top of the per-session cap of 5 wrong attempts. At most 10 guesses per phone per hour against 1,000,000 possible codes. No per-IP limit on this route in the MVP.
- Log: `requestId`, code, status. Never the phone, the OTP, tokens, token hashes, `fcmToken`, the provider session id or URL.
- **Audit log lines are not emitted yet.** A service has no access to the `requestId` (raw request access is banned, and no request context exists), so the `login.succeeded`, `otp.locked`, `login.banned` and `rider.created` lines wait for a request context (TRACKER). Until then the errors are logged by the exception filter with the `requestId`, and the events can be derived from the tables.
- Audit events: no audit table in the MVP (decision 134). One structured log line per event in the existing key=value style, with the `requestId` and a fixed event name only (`login.succeeded`, `otp.locked`, `login.banned`, `rider.created`); never the phone or ids. They can also be derived from `OtpSession`, `Device`, `Rider.createdAt` and `Rider.lastLoginAt`.

## Edge cases and known limitations
- This route reveals whether a phone has an account (`isNewRider`, `ACCOUNT_BANNED`), but only to someone who proved they hold the phone.
- A rider who is SUSPENDED or BLOCKED still costs an SMS at `send-otp` (that route never reads the Rider table).
- A login on a new device creates another `Device` and session; the old device keeps its session (one session per device, not per rider). **Rider single-device is TO DECIDE (decision 177); it is a one-line change** (delete the rider's other sessions after login, as the driver route does).
- A ban takes effect at once: the session guard checks the account status on every request, answers `ACCOUNT_BANNED` and deletes all the rider's sessions (decision 176).
- A rider who verifies and never completes the profile stays `PROFILE_PENDING` and keeps their phone. A later verify-otp logs them in (`isNewRider` false) and the app shows the profile screen. Cleaning up abandoned rows: TO DECIDE (`rider-register.md`).

## Required tests
- Happy path, login: ACTIVE rider, correct code: 200, `isNewRider` false, rider and tokens present; one Device row; `RefreshToken` stores the SHA-256 hash and differs from the returned token; session `verifiedAt` and `consumedAt` set; `lastLoginAt` set.
- Happy path, new phone: 200, `isNewRider` true, `rider` with `status` `PROFILE_PENDING`, `fullName` null, `email` null, `isPhoneVerified` true, `isProfileComplete` false; `tokens` present; no `registrationToken` and no top-level `profileComplete` key; one Rider, one Device, one RefreshToken storing the SHA-256 hash; session `verifiedAt` and `consumedAt` set. The same reply keys as an existing rider.
- No token needed (public). Wrong role: not applicable.
- A returning `PROFILE_PENDING` rider (second verify before the profile is done): 200, `isNewRider` false, same rider, new tokens, no second Rider row.
- Blocked account: SUSPENDED and BLOCKED riders get `ACCOUNT_BANNED`, no tokens, no Device or RefreshToken row, `consumedAt` set. DELETED gets `ACCOUNT_BANNED` the same way (confirmed, decision 138).
- Invalid input: missing fields, `otp` as a number, `otp` of 5 or 7 characters or with a letter, phone without `+91`, `device` missing, `device.platform` not in the list.
- Unknown field: `status`, `role`, `purpose`, an unknown field inside `device`.
- OTP: wrong code is `OTP_INVALID` and `attempts` goes up by 1; the 6th call after 5 wrong codes is `OTP_ATTEMPTS_EXCEEDED`; an expired session is `OTP_EXPIRED`; no session is `OTP_INVALID`; a used session is `OTP_INVALID`; an older session after a newer send is not accepted.
- Duplicate call: repeating a successful verify gets `OTP_INVALID` and issues nothing.
- Race condition: two simultaneous verifies with one correct code (exactly one succeeds); 20 parallel wrong guesses never exceed 5 attempts. Two simultaneous verifies for a new phone (real Postgres) create exactly one Rider.
- Device rules: a second login from the same device revokes the first token and leaves one unrevoked token; a login from a new device leaves both devices' tokens valid.
- Upstream failure: provider timeout, error and unreadable reply each give `OTP_PROVIDER_ERROR`, the attempt is given back, nothing is issued, and the provider is called exactly once.
- Transaction failure: if the Device insert fails, no RefreshToken or `consumedAt` remains.
- New-phone write failure: if any step of the transaction fails (mark used, create Rider, create Device, create RefreshToken), nothing remains and the same code works on the next try; a unique violation on the phone is `CONFLICT` and the code stays usable.
- Rate limit: the 11th verify attempt for one phone in an hour is `RATE_LIMITED` and calls the provider zero times.
- Secrets: no OTP, session id, token hash or provider URL in any reply or log line.

## Changelog
| Date | What changed | Why |
|---|---|---|
| 2026-10-05 | Draft created: login, new-rider and banned branches; registration token | Owner's unified flow brief |
| 2026-10-05 | Status changed from PROPOSED to APPROVED; verify-otp limited to 10 per phone per hour (replaces the open IP limit); DELETED riders get `ACCOUNT_BANNED` (plain unique phone) | Owner approval and decisions 120 to 129 |
| 2026-10-05 | device field rules; HS256 JWT claims; no audit table; DELETED confirmed as `ACCOUNT_BANNED`; shared types named | Owner decisions 130 to 140 |
| 2026-10-05 | `appVersion` rule; devices per rider, ban wording and token window settled (decision 144) | Owner decisions 141 to 145 |
| 2026-10-06 | Built: route, service, DTOs, HS256 access token (no new dependency), rider view; audit log lines deferred until a request context exists | verify-otp code step (decision 149) |
| 2026-10-06 | Reads only `RIDER_AUTH` sessions (a driver session is ignored) | Driver send-otp added `DRIVER_AUTH` sessions for the same phones (decision 150) |
| 2026-10-06 | New-phone path: marking the code used and storing the registration token hash are one conditional write; the Rider lookup now runs before the code is marked used | A crash could burn the code without issuing a token |
| 2026-10-07 | **Redesigned:** a new phone creates a `PROFILE_PENDING` Rider, Device and RefreshToken in one transaction and replies with the same shape as an existing rider (`isNewRider` true, `rider`, real tokens); `registrationToken` removed; `CONFLICT` added; `PROFILE_PENDING` riders can log in. Built 2026-10-08 (migration `20261007160000_rider_profile_pending`) | Owner instruction of 2026-10-07 (decision 162) |
| 2026-10-07 | Steps 2 to 5 and the single-use update moved to the shared `OtpCodeChecker` and `markCodeUsed` (`src/modules/otp/otp-code-checker.ts`); the DTOs moved to `src/modules/otp/dto/`; `AccessTokenService` moved to `src/common/jwt/`. No behavior change; the driver route uses the same code with purpose `DRIVER_AUTH` | Driver verify-otp (decision 155) |
| 2026-10-09 | **Server-side sessions:** `tokens` is now `{ accessToken, expiresInSeconds }` (opaque session token, 30 days sliding); `refreshToken`, `refreshTokenExpiresInSeconds`, `accessTokenExpiresInSeconds` and the JWT are gone | Decisions 174 to 178 |
| 2026-10-10 | **Device object changed (breaking for the apps):** `appVersion` is now `^[0-9A-Za-z.+_-]{1,20}$` (was three dotted numbers); `fcmToken` is no longer `TOO_SHORT` for `""`: omitted, `null` and `""` all mean not sent and never wipe a stored token, and a token with whitespace is `INVALID_FORMAT`; the field `platform` keeps its name. `platform`, `appVersion`, `fcmToken` are refreshed on the device row on every login. The `rider` object gains `gender`, `registeredAddress`, `termsAcceptedAt`, `termsVersion`. `lastLoginAt` is set on every success (already true; now tested) | Owner instruction of 2026-10-10 (decisions 179 to 182) |
| 2026-10-10 | `gender` is not in the `rider` object (removed from the API; the column is kept, decision 184) | Owner instruction of 2026-10-10 |
