# POST /v1/driver/auth/verify-otp

Status: Draft, written with the build on the owner's instruction of 2026-10-07; **not separately approved**. Every rule not stated here is the rule of `rider-verify-otp.md` (APPROVED), which this route shares code with. Items marked TO DECIDE have no decision yet.

The path `/v1/driver/auth/verify-otp` is as instructed; the controller writes `@Controller('driver/auth')` and never `v1`. Sibling: `driver-send-otp.md` (the route that sends the code). A driver register route is **not needed**: this route creates the account (decision 156). Profile, documents, vehicle and recharge are later steps and have no doc yet (CLAUDE.md rule 4 applies to them).

```
driver send-otp -> driver verify-otp -> (new phone)      Driver created (DOCUMENTS_PENDING) + tokens
                                     -> (existing driver) login + tokens
                                     -> (SUSPENDED / BLOCKED / DELETED) ACCOUNT_BANNED
```

## Purpose
The driver types the code they received. The server checks it with the OTP provider. If the phone is new, **in one database transaction** it marks the code used, creates the Driver (status `DOCUMENTS_PENDING`, phone verified), the DriverDevice and the first DriverRefreshToken, and replies with the driver and tokens. If the phone already has a driver, this is a login. A SUSPENDED, BLOCKED or DELETED driver is refused. There is no registration token and no separate register step.

## Who calls it
Driver app, after driver `send-otp`. Public endpoint (no token, no role; an explicit exception to the gate in `api-standard.md` section 1). The Driver role is attached to the access token this API issues. Gate checks: validation, per-phone limit, OTP.

## Request fields
Body, JSON: **identical to `rider-verify-otp.md`** (same DTO class, `src/modules/otp/dto/verify-otp.dto.js`). Nothing else is accepted; unknown fields (including `status`, `role`, `purpose`) are rejected with `UNKNOWN_FIELD`. Nothing is trimmed, lowercased or defaulted silently.

| Name | Type | Unit | Required? | Allowed range | Why it exists | Why this type/unit | Bucket | What breaks if wrong |
|---|---|---|---|---|---|---|---|---|
| phoneNumber | string | E.164 text | Required | `+91` + 10 digits, first of the 10 in 6 to 9 (`IndianMobile`) | Finds the OTP session and the driver | One canonical spelling per number | Identity | Wrong session or account |
| otp | string | digits as text | Required | Exactly 6 digits (`OtpCode`) | Proves the driver holds the phone | Text, so a leading zero survives | Input | A real driver fails |
| device | object | n/a | Required | Fields below; no unknown fields at any depth | Binds the tokens to one device | Nested object | Input | Tokens cannot be bound to a device |
| device.deviceId | string | text | Required | 1 to 64 characters, only `A-Z a-z 0-9 _ -` | App-generated install id; one refresh token per device | Text | Identity | Two devices share one token |
| device.platform | string | enum | Required | `ANDROID`, `IOS` | Admin and push routing | Enum, uppercase | Input | Wrong push channel |
| device.appVersion | string | text | Required | three dot-separated numbers like `1.4.2`, 1 to 3 digits each | Support and force-update | Text | Input | Cannot tell which build has a bug |
| device.fcmToken | string | text | Optional | 1 to 512 characters; never logged | Push notifications | Text | Input | No push messages |

The OTP purpose is never a request field. This route reads only sessions with purpose `DRIVER_AUTH`.

## Response fields
Success: HTTP 200 in both cases (TO DECIDE: a new driver is created, so 201 would also fit; 200 is used because the rider route does the same and a controller cannot choose the status per case without raw response access, which rule 13 bans). The app switches on `isNewDriver`. `data` is:

| Name | Type | Unit | Required? | Allowed range | Why it exists | Why this type/unit | Bucket | What breaks if wrong |
|---|---|---|---|---|---|---|---|---|
| isNewDriver | boolean | n/a | Always | `true` if this call created the account | App starts onboarding (documents) for a new driver | Boolean discriminator | Derived | App shows the wrong first screen |
| driver.id | string (UUID) | n/a | Always | n/a | The driver's id for later calls | Ids are UUIDs | Identity | App cannot refer to the driver |
| driver.phoneNumber | string | E.164 | Always | as stored | Shown in the app | E.164 | Identity | Wrong number shown |
| driver.status | string | enum | Always | `DriverStatus` value (a new driver is `DOCUMENTS_PENDING`) | App decides what the driver may do next | Enum, uppercase | Derived | App shows an approved driver as pending |
| driver.createdAtIst | string | `dd-mm-yyyy HH:mm:ss`, India time | Always | Example `"07-10-2026 19:23:10"` for `2026-10-07T13:53:10.203Z`. Added by the serializer step (`response-format.md` section 8); additive, so apps bound to `createdAt` keep working and need not format | Display in India | Text | Derived | Wrong time shown |
| driver.createdAt | string | ISO UTC `YYYY-MM-DDTHH:mm:ss.sssZ` | Always | n/a | Member since | UTC per `api-standard.md` | Derived | Wrong "member since" |
| tokens.accessToken | string | JWT | Always | valid 15 minutes, `role` claim `DRIVER` | Authenticates later calls | JWT, stateless | Derived | Driver cannot call APIs |
| tokens.accessTokenExpiresInSeconds | integer | seconds | Always | 900 | App schedules the refresh | Seconds | Reference (config) | App uses a dead token |
| tokens.refreshToken | string | opaque text | Always | valid 30 days | Gets a new access token | Opaque random value | Derived | Driver is logged out early |
| tokens.refreshTokenExpiresInSeconds | integer | seconds | Always | 2592000 | App knows when it must log in again | Seconds | Reference (config) | App keeps a dead token |

Never in the reply: `isPhoneVerified`, `lastLoginAt`, `deletedAt`, the token hash, the provider session id, `attempts`, any registration token (none exists), any internal row id other than `driver.id`.

## Order of operations
1. Validate the body.
2. **Shared code check** (`OtpCodeChecker.check`, the same code the rider route runs), with purpose `DRIVER_AUTH`:
   - per-phone limit: at most 10 verify attempts per phone per hour, counted from the `attempts` of that phone's `DRIVER_AUTH` sessions of the last hour (`RATE_LIMITED`, no provider call);
   - load the newest `DRIVER_AUTH` session for the phone: none or already used gives `OTP_INVALID`, expired gives `OTP_EXPIRED`, 5 attempts used gives `OTP_ATTEMPTS_EXCEEDED`;
   - reserve one attempt with one conditional update (parallel guesses cannot all pass);
   - ask the OTP provider (5 s timeout, no retry, never inside a DB transaction). A provider failure gives the attempt back and replies `OTP_PROVIDER_ERROR`; a wrong code keeps the attempt and replies `OTP_INVALID`.
3. Look up the Driver by phone. Only now, after the caller proved they hold the phone, does the account state matter.
4. **SUSPENDED, BLOCKED or DELETED:** one conditional update marks the code used and finished (`verifiedAt` and `consumedAt`); reply `ACCOUNT_BANNED`. No tokens.
5. **Otherwise (no driver, or any other status):** one database transaction:
   - a conditional update marks the code used and finished (`verifiedAt` null becomes now, `consumedAt` now). If it changes no row, another request used the code first: `OTP_INVALID`, nothing else is written. This is the **single-use** step and it runs first, so a parallel request waits on the row, then matches nothing;
   - **new phone:** create the Driver (`DOCUMENTS_PENDING`, `isPhoneVerified` true, `lastLoginAt` now). **Existing driver:** set `lastLoginAt`;
   - upsert the DriverDevice (create it, or update `platform`, `appVersion`, `lastSeenAt`, and `fcmToken` if sent);
   - revoke the device's earlier unrevoked DriverRefreshToken rows;
   - create the new DriverRefreshToken (SHA-256 hash only).
   A unique violation on the phone (another session created the Driver first) becomes `CONFLICT`; the whole transaction rolls back, so the code is not used.
6. Sign the access token (role `DRIVER`) and reply 200.

## Derived values
- `isNewDriver`, the driver object and the tokens are computed by the server. The client sends no status or role.
- Access token: signed JWT, 15 minutes, HS256, claims `iss` `treeps`, `sub` (the driver id), `role` `DRIVER`, `deviceId`, `iat`, `exp`. It is the same signer as the rider token (`src/common/jwt/access-token.service.ts`, secret `JWT_ACCESS_SECRET`); **the `role` claim is what keeps rider and driver tokens apart**, so every guard must check it (decision 158). Refresh token: 32 random bytes, base64url, 30 days, only its SHA-256 hash stored.

## Reference data used
OTP numbers, the 10-per-hour limit and the provider timeout as in `rider-send-otp.md` and `rider-verify-otp.md` (constants in `src/config/`). Access 900 s, refresh 2592000 s.

## State changes
- Before: one open `DRIVER_AUTH` `OtpSession`. After (new phone): `verifiedAt` and `consumedAt` set, one `Driver`, one `DriverDevice`, one `DriverRefreshToken`. After (existing driver): `verifiedAt` and `consumedAt` set, `DriverDevice` new or updated, the old token for that device revoked, a new `DriverRefreshToken`, `Driver.lastLoginAt` updated. After (banned): `verifiedAt` and `consumedAt` set, nothing else.
- Idempotency: natural, not replayable. The code is single use, so a repeated call gets `OTP_INVALID`. If the reply is lost, the driver asks for a new code and logs in. No `Idempotency-Key` header in the MVP.
- Concurrency: the conditional attempt update and the conditional `verifiedAt` update (first step of the transaction) make exactly one concurrent request win; two simultaneous verifies for a new phone create exactly one Driver (race test below). Two different codes for one new phone: the unique phone lets one win, the other gets `CONFLICT`.
- Failure: if any step of the transaction fails, nothing is written and the code stays usable.

## Data stored
`OtpSession` (updated), `Driver`, `DriverDevice`, `DriverRefreshToken` (hash only). The OTP and the provider session id are never in a reply or log. No limit on devices per driver in the MVP. **A full Aadhaar number is never stored anywhere** (decision 152).

## Data model (migration `20261007120000_driver_auth_data_model`, applied 2026-10-07)
`prisma/models/driver.prisma`. Conventions as the rider models: text uuid ids, camelCase, `timestamptz(3)`, enum values uppercase. The `DevicePlatform` enum is shared with the rider tables.

| Table | Columns and rules |
|---|---|
| Driver | `id` (uuid), `phoneNumber` (**unique**, plain unique for every row, so a DELETED driver keeps the phone, as decision 128 for riders), `status` enum `DriverStatus` (`DOCUMENTS_PENDING` default, `UNDER_REVIEW`, `APPROVED`, `REJECTED`, `SUSPENDED`, `BLOCKED`, `DELETED`), `isPhoneVerified` (default false; the server sets true after the OTP check), `lastLoginAt?`, `deletedAt?`, `createdAt`, `updatedAt` |
| DriverDevice | One row per driver install: `driverId`, `deviceId` (the app's install id), `platform`, `appVersion`, `fcmToken?`, `lastSeenAt`. Unique `(driverId, deviceId)`; deleted with the driver |
| DriverRefreshToken | `tokenHash` (unique, SHA-256), `driverId` and `deviceId` (the pair points to DriverDevice), `expiresAt`, `revokedAt?`, `createdAt`. Index `(driverId, deviceId)`. Revoked rows are kept (reuse detection) |

Separate tables from the rider ones: no foreign key is shared and nullable. Profile, documents, vehicle and recharge come later as nullable columns or separate tables. There is no live-location or online state here.

## Errors
All errors use the envelope in `standards/response-format.md`. Same codes and wording as the rider route.

| Code | HTTP status | When it happens | `field` marker | Driver-safe message | How the app UI should react |
|---|---|---|---|---|---|
| INVALID_INPUT | 400 | Missing, wrong type, wrong format or unknown field at any depth (`details` lists all) | first invalid field | "Please check your input." | Highlight the fields in `details` |
| OTP_INVALID | 422 | No usable `DRIVER_AUTH` session, an already-used session, or a wrong code | otp | "That code is not right. Please check and try again." | Let the driver retype or resend |
| OTP_EXPIRED | 422 | The newest session is older than 5 minutes | otp | "That code has expired. Please ask for a new one." | Show "send a new code" |
| OTP_ATTEMPTS_EXCEEDED | 429 | 5 wrong codes already used on this session | otp | "Too many wrong codes. Please ask for a new code." | Force "send a new code" |
| ACCOUNT_BANNED | 403 | The driver is SUSPENDED, BLOCKED or DELETED | null | "This account can't book rides." (the registry wording; fitting it to drivers is TO DECIDE) | Show support contact |
| OTP_PROVIDER_ERROR | 503 | The provider timed out, refused, or sent an unreadable reply | null | "We couldn't reach the code service. Please try again." | Show retry; the attempt was not used |
| RATE_LIMITED | 429 | More than 10 verify attempts for this phone in the last hour | null | "Too many requests. Try again shortly." | Disable the button briefly |
| CONFLICT | 409 | Another session created this phone's Driver at the same moment (rare); the code is not used | null | "This can't be done right now. Please refresh and try again." | Ask for a new code; the next verify logs in |
| INTERNAL_ERROR | 500 | A bug or a database failure | null | "Something went wrong. Please try again." | Show retry; the code is still usable because the transaction rolled back |

## Where it lives
- `src/modules/driver-auth/`: `driver-verify-otp.service.ts` (`DriverVerifyOtpService`, `driverView`), the route in `driver-auth.controller.ts`, `driver-auth.module.ts`.
- **Shared with the rider route** (not copied): `src/modules/otp/otp-code-checker.ts` (`OtpCodeChecker.check` is steps 1 to 5 of the rider order, and `markCodeUsed` is the single-use step), the DTOs `src/modules/otp/dto/verify-otp.dto.ts` and `device.dto.ts`, `src/common/jwt/access-token.service.ts` (`AccessTokenService.issueForDriver`, with its `AccessTokenModule`), `src/common/database/unique-violation.ts`. The rider service calls the same checker with purpose `RIDER_AUTH`.
- The time comes from the injectable clock (`src/common/clock.ts`).

## Rate limit, logging and audit
- Rate limit: as the rider verify route: 10 verify attempts per phone per hour (counted from `OtpSession.attempts`, on top of the 5 per session) and **no per-IP limit** on this route in the MVP, so no `@RateLimit`.
- Log: `requestId`, code, status. Never the phone, the OTP, tokens, hashes, `fcmToken`, the provider session id or URL.
- Audit log lines (`driver.login.succeeded`, `driver.created`, `driver.login.banned`) are **not emitted yet**: a service has no access to the `requestId` (the TRACKER item for the rider routes). The tables are the durable record.
- **Admin visibility** (CLAUDE.md): this is a user-facing domain, so driver audit, tracking and metrics endpoints are owed. None is built. **Whether the exception of decision 119 (rider auth ships before admin auth) also covers drivers: TO DECIDE.**

## Edge cases and known limitations
- This route reveals whether a phone has a driver account (`isNewDriver`, `ACCOUNT_BANNED`), but only to someone who proved they hold the phone.
- A SUSPENDED or BLOCKED driver still costs an SMS at `send-otp` (that route never reads an account table).
- A driver whose status is `DOCUMENTS_PENDING`, `UNDER_REVIEW`, `APPROVED` or `REJECTED` can log in. What each status may do after login is decided by later APIs. Whether a `REJECTED` driver should be refused here: TO DECIDE.
- A login on a new device creates another DriverDevice and token; the old device's token is not touched (one token per device).
- Access tokens already issued stay valid until they expire (15 minutes) even after a ban (as for riders, decision 144).
- A person may hold a rider and a driver account with one phone (the two are separate tables and separate codes); whether that is allowed for good: TO DECIDE (as in `driver-send-otp.md`).
- The rider route could not tell a driver token from a rider token if a guard ignored `role`. The JWT guard (F4) must check `role` against the route's domain.

## Required tests
- New phone: the driver is created `DOCUMENTS_PENDING` with `isPhoneVerified` true; one DriverDevice; one DriverRefreshToken storing only the SHA-256 hash; the session has `verifiedAt` and `consumedAt`; the reply has `isNewDriver` true, `driver` with exactly `createdAtIst` (the Indian-time twin of `createdAt`) and `id`, `phoneNumber`, `status`, `createdAt`, tokens, and no registration token.
- Existing driver: login, `isNewDriver` false, `lastLoginAt` set, no second Driver.
- SUSPENDED, BLOCKED and DELETED: `ACCOUNT_BANNED` (403), no tokens, no device, session finished.
- Code: wrong gives `OTP_INVALID`, expired gives `OTP_EXPIRED`, used gives `OTP_INVALID`.
- Isolation: a `RIDER_AUTH` session does not work on this route (no provider call, nothing created); a `DRIVER_AUTH` session does not work on the rider route.
- Transaction failure: a failure at each step (mark used, create Driver, device, refresh token) leaves nothing and the code is still usable; a unique violation on the phone is `CONFLICT` and the code stays usable.
- Role: the access token's `role` claim is `DRIVER` (and `RIDER` for a rider).
- Envelope and validation: 200 in the standard envelope, not served without `/v1`, the same invalid-input and unknown-field answers as the rider route.
- Race (real Postgres): two simultaneous verifies for a new phone create exactly one Driver.

## Race tests (real Postgres)
`src/modules/driver-auth/driver-verify-otp.pg.spec.ts`, skipped unless `RUN_PG_TESTS=1`, so `npm test` stays database-free. It uses only a scratch database named `treeps_scratch_driver` (a constant in `src/modules/rider-auth/testing/scratch-db.ts`; only host, port, user and password come from `DATABASE_URL`, so it can never open `treeps_db`). It creates that database and its tables if missing and empties the driver auth tables before and after. Run (PowerShell, project root, local Postgres running):
```
$env:RUN_PG_TESTS = '1'; npx vitest run src/modules/driver-auth/driver-verify-otp.pg.spec.ts
```
A barrier holds both requests until each has passed the code check and the driver lookup, so the race happens inside the transaction. Ten rounds: exactly one `OK`, the other `OTP_INVALID`, one Driver per phone.

## Changelog
| Date | What changed | Why |
|---|---|---|
| 2026-10-07 | Draft created and built: driver verify-otp, `Driver`, `DriverDevice`, `DriverRefreshToken`, role `DRIVER`, one transaction for create and login, shared code check | Owner instruction of 2026-10-07 (decisions 152 to 159) |
