# POST /v1/rider/auth/register

Status: APPROVED (owner, 2026-10-05). Built 2026-10-07 (see Where it lives). Items still marked TO DECIDE must be resolved in this doc before the code that needs them is written (CLAUDE.md rule 12). A change after approval needs a changelog row.

The path `/v1/rider/auth/register` is APPROVED; the controller writes `@Controller('rider/auth')` and never `v1`. Sibling docs: `rider-send-otp.md`, `rider-verify-otp.md`, `rider-refresh.md`, `rider-logout.md`.

## Flow (APPROVED)
One phone-OTP flow serves login and registration:

```
send-otp -> verify-otp -> (existing ACTIVE rider) tokens                  = login
                       -> (unknown phone) isNewRider + registrationToken -> register -> tokens
                       -> (SUSPENDED / BLOCKED) ACCOUNT_BANNED
refresh: new token pair, rotating        logout: revoke this device's token
```
- `send-otp` never reads the Rider table and replies the same for any phone.
- `verify-otp` checks the OTP, then decides login, new rider or banned.
- `register` (this doc) takes the one-time **registration token** that `verify-otp` issued, plus the profile. It no longer takes the OTP or the phone number: the server reads the verified phone from the session the token belongs to.
- The data model needs no change for this flow: `OtpSession.verifiedAt` marks the OTP as used, `registrationTokenHash` and `registrationExpiresAt` hold the token, and `consumedAt` marks the session finished (see Data model).

## Purpose
A person whose phone number `verify-otp` proved, and found to have no account, creates their Rider account. In one call the server checks the registration token, creates the Rider, the Device and the first refresh token in one transaction, and returns the rider and the tokens. There is no OTP and no call to the SMS provider at this step.

## Who calls it
Rider app, right after `verify-otp` replied `isNewRider: true`. Public endpoint (no access token; an explicit exception to the gate in `api-standard.md` section 1): the one-time registration token is the credential. The Rider role is attached to the token this API issues. Gate checks: throttler guard, validation, registration token.

## Request fields
Body, JSON. **Nothing else is accepted**; unknown fields (including `phoneNumber`, `otp`, `status`, `isPhoneVerified`, `isEmailVerified`, `role`, `id`) are rejected with `UNKNOWN_FIELD`. No field is trimmed, lowercased or defaulted silently (`input-validation.md` rule 3).

| Name | Type | Unit | Required? | Allowed range | Why it exists | Why this type/unit | Bucket | What breaks if wrong |
|---|---|---|---|---|---|---|---|---|
| registrationToken | string | opaque text | Required | 43 characters, base64url of 32 random bytes (APPROVED) | Proves the phone was verified and carries it; replaces the old `otp` field | Opaque random value; the phone is not sent again, so it cannot be changed between verify and register | Identity | Anyone could register any phone |
| fullName | string | text | Required | 2 to 100 characters (code points; the column is `VarChar(100)`). Only Unicode letters and combining marks, space, `.`, `'`, the curly `’` (U+2019) and `-`. No leading or trailing space, no two spaces in a row; the hyphen may not be first, last or doubled. (decisions 135, 141) | The rider's name shown to drivers; one column instead of first and last | One text field: names do not split reliably into two parts | Input | Unreadable or abusive names; a stray space makes the same name look different |
| email | string | text | Optional | At most 254 characters; shape rule below | Contact and receipts | Text | Input | Bad receipts; duplicate accounts |
| registeredCity | string | text | Optional, may be `null` | 1 to 100 characters | Where the rider registered, from Google Maps | Text as Maps returns it | Input | None for the ride flow: it is informational and must never block registration |
| registeredState | string | text | Optional, may be `null` | 1 to 100 characters | As above | As above | Input | As above |
| device | object | n/a | Required | Fields below; no unknown fields at any depth | Lets the server bind tokens to one device | Nested object | Input | Tokens cannot be bound to a device |
| device.deviceId | string | text | Required | 1 to 64 characters, only `A-Z a-z 0-9 _ -` (decision 132) | App-generated install id; one refresh token per device | Text | Identity | Two devices share one token |
| device.platform | string | enum | Required | `ANDROID`, `IOS` | Admin and push routing | Enum, uppercase (CLAUDE.md rule 11) | Input | Wrong push channel |
| device.appVersion | string | text | Required | three dot-separated numbers like `1.4.2`, 1 to 3 digits each (decision 143) | Support and force-update | Text | Input | Cannot tell which app build has a bug |
| device.fcmToken | string | text | Optional | 1 to 512 characters (decision 132); never logged | Push notifications | Text | Input | No push messages |

Rules for the rows above:
- **Phone:** not in this request. The server uses the phone stored on the `OtpSession` that the registration token belongs to. The phone format rule (`+91` and 10 digits starting 6 to 9) is in `rider-send-otp.md` and is stored exactly as the app sent it there.
- **registrationToken:** a token that is unknown, already used, expired (10 minutes after verify), or whose OTP was never verified gives one code, `REGISTRATION_TOKEN_INVALID`, so a reply never says which. It uses the `OpaqueToken` type (`input-validation.md` section 2b).
- **fullName:** the `PersonName` type (`input-validation.md` section 2b). Violations are rejected, never fixed. Reasons: `TOO_SHORT`, `TOO_LONG`, and `INVALID_FORMAT` for a disallowed character, a leading or trailing space, or a double space. Letters and combining marks mean Devanagari and other Indian-script names are accepted. **The hyphen `-` is allowed (decision 141), so `Mary-Jane` is valid, but not as the first or last character and not twice in a row (`--`).** Known limits: a name made only of punctuation (`.`, `'`, `’`) passes the character rule, and two spellings of the same accented letter (precomposed or with a combining mark) are stored as sent.
- **email:** optional; omitted means no email. `null` is `WRONG_TYPE` (decision 46). No lowercasing: an address containing an uppercase letter or any space is rejected with `INVALID_FORMAT`, and the app lowercases before sending (APPROVED). Why: Postgres unique is case-sensitive, so `A@x.com` and `a@x.com` would otherwise be two accounts. An email that already belongs to another rider is `EMAIL_IN_USE`. The shape rule is the `Email` type in `input-validation.md` section 2b (decision 136).
- **registeredCity / registeredState:** the only fields with a documented **explicit normalization** (flagged, owner to confirm): the server trims leading and trailing whitespace before storing, and stores `null` if nothing is left. Why: the owner decided these must never block registration and are stored as Google Maps returns them, trimmed. Everything else is stored exactly as sent. `null` is accepted (the app may have no Maps result). An empty string `""` is rejected (`TOO_SHORT`); the app omits the field or sends `null`. A wrong type, a value over 100 characters or one containing U+0000 is still `INVALID_INPUT`, because ignoring it silently would be coercion. Ignoring bad values instead is not done (decision 144).
- **device:** `device.deviceId` etc. use the dot-path field names from `input-validation.md` section 4. The shape is the same in `verify-otp`.

Shared types (`input-validation.md` section 2b): `OpaqueToken`, `PersonName`, `Email`, `DeviceId`, `AppVersion`, `Text` for the city, state and `fcmToken`, `OneOf` for `platform`, `Nested` for `device`.

## Response fields
Success: HTTP 201 (APPROVED; a Rider is created. Once apps ship the status must not change). `data` is `{ rider, tokens }`. The same `rider` and `tokens` objects are returned by `verify-otp` (login, HTTP 200) and `tokens` by `refresh`:

| Name | Type | Unit | Required? | Allowed range | Why it exists | Why this type/unit | Bucket | What breaks if wrong |
|---|---|---|---|---|---|---|---|---|
| rider.id | string (UUID) | n/a | Always | n/a | The rider's id for later calls | Ids are UUIDs | Identity | App cannot refer to the rider |
| rider.fullName | string | text | Always | as stored | Shown in the app | Text | Derived (stored) | Wrong name shown |
| rider.phoneNumber | string | E.164 | Always | as stored | Shown in the app | E.164 | Identity | Wrong number shown |
| rider.email | string or null | text | Always | `null` if none | Shown in the app | Text | Derived (stored) | Wrong email shown |
| rider.registeredCity | string or null | text | Always | as stored | Shown in the app | Text | Derived (stored) | None |
| rider.registeredState | string or null | text | Always | as stored | As above | Text | Derived (stored) | None |
| rider.status | string | enum | Always | `ACTIVE` (new riders) | App can show account state | Enum | Derived | App treats a blocked rider as active |
| rider.isPhoneVerified | boolean | n/a | Always | `true` | Confirms the phone was proven | Boolean | Derived | None |
| rider.isEmailVerified | boolean | n/a | Always | `false` (nothing verifies an email in the MVP) | App knows the email is not yet proven | Boolean | Derived | App trusts an unverified email |
| rider.isProfileComplete | boolean | n/a | Always | `false` at register (nothing in this feature sets it true; a later profile API will, decision 144) | App can prompt the rider to finish the profile | Boolean | Derived | App skips or repeats the prompt |
| rider.createdAt | string | ISO UTC `YYYY-MM-DDTHH:mm:ss.sssZ` | Always | n/a | Member since | UTC per `api-standard.md`; the apps and admin show IST `DD-MM-YYYY HH:MM:SS` | Derived | Wrong "member since" |
| tokens.accessToken | string | JWT | Always | valid 15 minutes | Authenticates later calls | JWT, stateless | Derived | Rider cannot call APIs |
| tokens.accessTokenExpiresInSeconds | integer | seconds | Always | 900 | App schedules the refresh | Seconds, no clock parsing | Reference (config) | App uses a dead token |
| tokens.refreshToken | string | opaque text | Always | valid 30 days | Gets a new access token | Opaque random value, not a JWT (APPROVED) | Derived | Rider is logged out early |
| tokens.refreshTokenExpiresInSeconds | integer | seconds | Always | 2592000 | App knows when it must log in again | Seconds | Reference (config) | App keeps a dead token |

Never in the reply: `deletedAt`, `lastLoginAt`, the token hash, the provider session id, `attempts`, any internal row id other than `rider.id`.

## Derived values
- The phone number comes from the `OtpSession` of the registration token, never from the client.
- Server-set on the new Rider: `status` = `ACTIVE`, `isPhoneVerified` = `true`, `isEmailVerified` = `false`, `isProfileComplete` = `false`, `lastLoginAt` = now (registration counts as the first login), `createdAt`/`updatedAt` = now.
- Access token: signed JWT, 15 minutes, algorithm HS256 (decision 133), signed with `JWT_ACCESS_SECRET` (at least 32 characters; the app refuses to start if it is shorter). Issuer `treeps`. Claims: `sub` (the rider id), `role` (`RIDER`), `deviceId` (the install id), plus the standard `iat` and `exp`. Verification accepts only HS256, never `none` or any other algorithm.
- Refresh token: 32 random bytes from `crypto.randomBytes`, encoded base64url (APPROVED), shown to the app once; rotation and reuse rules are in `rider-refresh.md`. Only its SHA-256 hash (Node `crypto`, hex) is stored. A plain SHA-256 is acceptable because the token is long and random (not a password); confirmed by decision 116.

## Order of operations
1. Throttler guard (IP): 10 registers per hour per IP (see Rate limit). Before everything else.
2. Validate the body.
3. Hash the registration token (SHA-256) and load the `OtpSession` whose `registrationTokenHash` matches. `REGISTRATION_TOKEN_INVALID` if there is none, its purpose is not `RIDER_AUTH`, `consumedAt` is set, `verifiedAt` is null, or `registrationExpiresAt` is not in the future (the token is already invalid at the exact expiry instant).
4. Pre-checks, before the token is consumed, so a fixable mistake does not burn it:
   - a Rider with this email already exists: `EMAIL_IN_USE`;
   - a Rider with the session's phone already exists (another session registered it first): `CONFLICT`. The app restarts at `send-otp` and the next `verify-otp` logs in.
5. One database transaction:
   - a **conditional update** sets `consumedAt` on the session where its hash matches, `consumedAt` is null and `registrationExpiresAt` is in the future; if it changes no row, `REGISTRATION_TOKEN_INVALID` (a parallel request used the token first). This is the **single-use** step;
   - create the Rider (phone from the session, `isPhoneVerified` true);
   - create the Device;
   - create the first RefreshToken (SHA-256 hash only).
   A unique-constraint failure on email becomes `EMAIL_IN_USE`, and on phone becomes `CONFLICT`; the whole transaction rolls back, including `consumedAt`, so the token is usable again after the rider fixes the email.
6. Sign the access token and reply 201.

## Where it lives
`src/modules/rider-auth/`: `register.service.ts` (`RegisterService.register`, the order of operations above), `dto/register.dto.ts` (`RegisterDto`, using `OpaqueToken`, `PersonName`, `Email`, `Text`, `Nested`, and the new `OptionalNullable` for city and state), and the route in `rider-auth.controller.ts` (`@RateLimit({ name: 'register', ip: RATE_LIMITS.register.ip })`, `@HttpCode(201)`). It reuses `AccessTokenService`, `riderView`, `newOpaqueToken` and `sha256Hex`, the same helpers verify-otp uses. The time comes from the injectable clock (`src/common/clock.ts`).

- The new Device is created with `create` (a new rider has no device, so this equals an upsert).
- How a unique violation is recognized: Prisma 7 with the pg adapter reports `P2002` and names the violated index in `meta.driverAdapterError.cause.constraint.index` (`Rider_email_key` or `Rider_phoneNumber_key`, checked against real Postgres on 2026-10-07). An index with `email` in its name becomes `EMAIL_IN_USE`, with `phoneNumber` becomes `CONFLICT`; any other error is not translated.
- City and state: validated as sent (`""` is `TOO_SHORT`, through the `Text` option `emptyIsTooShort`), then trimmed by the service; nothing left stores `null`.
- The `rider.registered` log line is **not emitted yet**, for the same reason as the verify-otp lines: a service has no access to the `requestId` (TRACKER).

## Reference data used
Config values, never hardcoded: registration-token lifetime 600 s, access TTL 900 s, refresh TTL 2592000 s, the register rate limit. These are constants in one config file, not environment variables. The only new environment key here is `JWT_ACCESS_SECRET` (decisions 133 and 139; its rule is in `input-validation.md` section 6 and its `.env.example` line is added in the code commit). The OTP numbers and the provider settings belong to `rider-send-otp.md`.

## State changes
- Before: no Rider for this phone; one `OtpSession` with `verifiedAt` and a registration token. After: one `Rider` (`ACTIVE`, phone verified, `lastLoginAt` set), one `Device`, one `RefreshToken`; the session has `consumedAt` set.
- Idempotency: natural (APPROVED). The registration token is single use, so a repeated call cannot create a second Rider: it gets `REGISTRATION_TOKEN_INVALID`. No `Idempotency-Key` header in the MVP. If the reply is lost in transit the rider is registered but has no tokens; they ask for a new code, and `verify-otp` logs them in (`isNewRider` false).
- Concurrency: two simultaneous registers with one token: the conditional `consumedAt` update lets exactly one win. Two different tokens for one phone: the unique phone lets exactly one win; the other gets `CONFLICT`.

## Data stored
`Rider`, `Device`, `RefreshToken` (token hash only) and the updated `OtpSession` (`consumedAt`). Nothing is snapshotted. Dates are stored as `timestamptz` (a real instant, shown in UTC by the API).

## Data model (FINAL design, 2026-10-05 - NOT applied)
The owner fixed this design on 2026-10-05 (decisions 100 to 108); the flow that uses it is in decisions 109 to 119. Nothing here changes `prisma/` yet. The block was checked with `prisma validate` on a scratch copy outside the repo (valid) and nothing was run against the database. The owner types it into `prisma/models/` later. Conventions kept: text uuid ids (`@default(uuid())`), camelCase, no `@@map`, enum values uppercase. Rider keeps every existing column that is not listed as changed (`email`, `profilePicture`, `isProfileComplete`, `createdAt`, `updatedAt`, the `SavedPlace` and `EmergencyContact` relations).

```prisma
enum RiderStatus {
  ACTIVE
  SUSPENDED
  BLOCKED
  DELETED
}

enum Gender {
  MALE
  FEMALE
  OTHER
}

enum OtpPurpose {
  RIDER_AUTH
  DRIVER_AUTH
}

enum DevicePlatform {
  ANDROID
  IOS
}

model Rider {
  id                String             @id @default(uuid())
  phoneNumber       String             @unique
  fullName          String             @db.VarChar(100)
  email             String?            @unique
  gender            Gender?
  dateOfBirth       DateTime?          @db.Date
  profilePicture    String?
  registeredCity    String?
  registeredState   String?
  status            RiderStatus        @default(ACTIVE)
  isPhoneVerified   Boolean            @default(false)
  isEmailVerified   Boolean            @default(false)
  isProfileComplete Boolean            @default(false)
  lastLoginAt       DateTime?          @db.Timestamptz(3)
  deletedAt         DateTime?          @db.Timestamptz(3)
  createdAt         DateTime           @default(now()) @db.Timestamptz(3)
  updatedAt         DateTime           @updatedAt @db.Timestamptz(3)

  devices           Device[]
  savedPlaces       SavedPlace[]
  emergencyContacts EmergencyContact[]

  @@index([status])
  @@index([createdAt])
}

model OtpSession {
  id                    String     @id @default(uuid())
  phoneNumber           String
  purpose               OtpPurpose
  providerSessionId     String
  attempts              Int        @default(0)
  expiresAt             DateTime   @db.Timestamptz(3)
  verifiedAt            DateTime?  @db.Timestamptz(3)
  consumedAt            DateTime?  @db.Timestamptz(3)
  registrationTokenHash String?    @unique
  registrationExpiresAt DateTime?  @db.Timestamptz(3)
  createdAt             DateTime   @default(now()) @db.Timestamptz(3)

  @@index([phoneNumber, createdAt])
}

model Device {
  id            String         @id @default(uuid())
  riderId       String
  rider         Rider          @relation(fields: [riderId], references: [id], onDelete: Cascade)
  deviceId      String
  platform      DevicePlatform
  appVersion    String
  fcmToken      String?
  lastSeenAt    DateTime       @db.Timestamptz(3)
  refreshTokens RefreshToken[]

  @@unique([riderId, deviceId])
}

model RefreshToken {
  id        String    @id @default(uuid())
  tokenHash String    @unique
  riderId   String
  deviceId  String
  device    Device    @relation(fields: [riderId, deviceId], references: [riderId, deviceId], onDelete: Cascade)
  expiresAt DateTime  @db.Timestamptz(3)
  revokedAt DateTime? @db.Timestamptz(3)
  createdAt DateTime  @default(now()) @db.Timestamptz(3)

  @@index([riderId, deviceId])
}
```

`SavedPlace` and `EmergencyContact` stay exactly as they are today (their endpoints are deferred, and removing a table is a separate approved step).

### Rider: what changes
| Column | Final | Why it exists |
|---|---|---|
| fullName | `String @db.VarChar(100)`, required (replaces `firstName` + `lastName`) | One name field; the database also enforces the 100-character limit (Postgres counts characters, matching the code-point rule of the API) |
| status | enum `RiderStatus`, default `ACTIVE` | Lets an admin suspend or block a rider and lets a soft delete exist |
| isPhoneVerified | `Boolean @default(false)` (was `true`) | A row never claims a phone is verified unless the server set it; the server sets `true` after the OTP check |
| isEmailVerified | `Boolean @default(false)` (new) | Records whether the email was proven. Nothing in the MVP verifies an email, so it stays `false` until an email-verification flow exists |
| registeredCity, registeredState | `String?` | Plain text as Google Maps returns it; informational; never blocks registration |
| lastLoginAt | `DateTime? @db.Timestamptz(3)` | Support and admin metrics; set at register and at every login |
| deletedAt | `DateTime? @db.Timestamptz(3)` | When a soft delete happened |
| gender | optional enum `Gender` (`MALE`, `FEMALE`, `OTHER`, decision 131) | Not collected at register |
| dateOfBirth | `DateTime? @db.Date` | Date only, no time; not collected at register |

### New tables
| Table | Columns and rules |
|---|---|
| OtpSession | One row per OTP sent. `phoneNumber`; `purpose` (`RIDER_AUTH` or `DRIVER_AUTH`; the driver value was added by migration `20261006105503_add_driver_auth_otp_purpose`); `providerSessionId` (provider session id, server only, never returned); `attempts` (default 0); `expiresAt` (send time + 5 min); `verifiedAt` (set once, by a conditional update, when the provider confirms the code: this makes the OTP single use); `consumedAt` (set when the session is finished: login tokens issued, a banned login refused, or registration done); `registrationTokenHash` (unique; SHA-256 of the one-time registration token issued to an unknown phone, never the token) and `registrationExpiresAt` (verify time + 10 min); `createdAt`. Index `(phoneNumber, createdAt)`. Meanings are APPROVED, as set by the flow in this doc |
| Device | One row per rider install. `riderId`; `deviceId` (the app's install id); `platform` (`ANDROID`, `IOS`); `appVersion`; `fcmToken?`; `lastSeenAt`. Unique `(riderId, deviceId)` |
| RefreshToken | One row per refresh token. `tokenHash` (unique, SHA-256 of the token; the token itself is never stored); `riderId` and `deviceId` (the pair points to `Device`); `expiresAt`; `revokedAt?`; `createdAt`. Index `(riderId, deviceId)`. **Revoked rows are kept**: a rotated token that is presented again is how reuse is detected |

Naming notes:
- `OtpSession.phoneNumber` matches `Rider.phoneNumber` and the API field (`EmergencyContact.phone` stays as is).
- `Device.deviceId` is the app's install id; `Device.id` is the server's uuid. `RefreshToken` points at its Device by the pair `(riderId, deviceId)`, so it needs no separate `riderId` relation.
- Index on every foreign key: `Device.riderId` is covered by the unique `(riderId, deviceId)` (its first column); `RefreshToken (riderId, deviceId)` has its own index; `SavedPlace` and `EmergencyContact` `riderId` are **not** indexed today (existing gap, out of scope, reported only).
- Enums are global across the whole `prisma/` folder. There is no enum in the schema today, so there is no name clash. A future Driver model must reuse `Gender` and `DevicePlatform` and not declare its own. `OtpPurpose` is a single value now; a driver flow adds `DRIVER_AUTH` with a new migration (adding an enum value is easy in Postgres, removing one is not).

### Migration impact
Checked on 2026-10-04 with a read-only `count(*)` on the dev database `treeps_db`: `Rider` 0 rows, `SavedPlace` 0 rows, `EmergencyContact` 0 rows. (Nothing else in the repo creates Riders: the only writer, `src/auth/auth.service.ts`, uses the removed `prisma.user` and cannot run.) The count must be repeated just before the migration is applied, and a production database must be checked on its own (production migration process: TO DECIDE, `runbooks/database.md`).

| Change | What the migration does | Risk with 0 rows | Risk if rows existed |
|---|---|---|---|
| `firstName` + `lastName` replaced by `fullName VarChar(100)` | Prisma's generated SQL drops two columns and adds a `NOT NULL` column with no default | Works, but Prisma prints a data-loss warning | Fails (a `NOT NULL` column cannot be added to a table with rows) or loses names. Use the hand-edited SQL below |
| `gender` text to enum `Gender` | Prisma drops and re-adds the column | Works | Existing free text would be lost. Hand-edit to `ALTER COLUMN "gender" TYPE "Gender" USING "gender"::"Gender"`, which fails if any value is not one of the enum values. Enum values: `MALE`, `FEMALE`, `OTHER` (decision 131) |
| `dateOfBirth` timestamp to `@db.Date` | Column type changes to `DATE` | Works | The time part is dropped |
| `createdAt`, `updatedAt` to `timestamptz(3)` (and the new columns) | `ALTER COLUMN ... TYPE TIMESTAMPTZ(3)` | Works | The migration reads the stored values as UTC (`USING ... AT TIME ZONE 'UTC'`), so none shift |
| `isPhoneVerified` default `true` to `false` | `SET DEFAULT false` only | Works | Existing rows keep their value; no row is changed |
| New `isEmailVerified` | Adds `BOOLEAN NOT NULL DEFAULT false` | Works | Works; existing rows get `false` |
| New `status`, `registeredCity`, `registeredState`, `lastLoginAt`, `deletedAt` | Adds columns; `status` has default `ACTIVE`, the rest are nullable | Works | Works; existing rows become `ACTIVE` |
| New indexes `status`, `createdAt` | Creates two indexes | Works | Brief lock on a very large table |
| New tables `OtpSession`, `Device`, `RefreshToken`, new enums | Creates them | Works | Works |

The migration file exists, created with `prisma migrate dev --create-only` on 2026-10-05 and hand-edited, and is **not applied yet**: `prisma/migrations/20261005101140_rider_auth_data_model/migration.sql`. The Rider part (the generated drop-and-add was replaced):
```sql
ALTER TABLE "Rider" ADD COLUMN "fullName" VARCHAR(100);
UPDATE "Rider" SET "fullName" = left(btrim(concat_ws(' ', "firstName", "lastName")), 100);
ALTER TABLE "Rider" ALTER COLUMN "fullName" SET NOT NULL;
-- ...the other new columns, then:
ALTER TABLE "Rider" ALTER COLUMN "gender" TYPE "Gender" USING "gender"::"Gender";
ALTER TABLE "Rider" ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC';
ALTER TABLE "Rider" DROP COLUMN "firstName", DROP COLUMN "lastName";
```
The merge is `firstName`, a space, then `lastName` when it is not null (`concat_ws` skips a null). `left(..., 100)` would silently cut a longer name, and the result is not re-checked against the name rules. Both matter only if rows exist; with 0 rows the `UPDATE` changes nothing.

References to the old columns: `prisma/models/rider.prisma` (the `firstName` and `lastName` lines), `prisma/migrations/20260929133200_init/migration.sql` (history, never edited), and no file under `src/` and no doc other than these. After the migration the Prisma client is regenerated; nothing else needs a code change.

Process (from `runbooks/database.md`): `prisma validate`, `prisma migrate dev --create-only --name rider_register`, read and edit the SQL, then apply. Never `migrate reset`, `db push` or `--force`. The backup in `runbooks/database.md` stays valid; take a fresh one before applying.

### DELETED riders and the unique phone
`phoneNumber` is `@unique` for every row, so a rider whose status is `DELETED` keeps the number and that phone can never register again (verify-otp would find a DELETED Rider, and a registration for that phone would hit the unique and reply `CONFLICT`). `email` has the same property. **Decision 128 (APPROVED): keep the plain unique.** A DELETED rider keeps their phone and email for good; verify-otp answers `ACCOUNT_BANNED` for that phone, so it never reaches register. No delete flow exists yet, so this costs nothing today. Anonymizing on delete and a partial unique index were considered and are not used (a partial index is raw SQL that Prisma cannot express and may try to drop). Revisit when a delete or restore flow is built.

Other schema points (decision 144):
- `isProfileComplete` stays `false`; nothing in this feature sets it.
- No retention or cleanup of `OtpSession` and revoked `RefreshToken` rows in the MVP; they are kept.
- Deferred, not in this feature (decision 108): ratings and ride counters, block reason and audit columns, referral, UTM, terms and consent, `profilePhotoKey`, `preferredLanguage`, `signupSource`, `registrationIpHash`, `tokenVersion`, emergency-contact and saved-place endpoints.

## Errors
All errors use the envelope in `standards/response-format.md`.

| Code | HTTP status | When it happens | `field` marker | Rider-safe message | How the app UI should react |
|---|---|---|---|---|---|
| INVALID_INPUT | 400 | Missing, wrong type, wrong format, too short or long, or unknown field at any depth (`details` lists all) | first invalid field | "Please check your input." | Highlight the fields in `details` |
| REGISTRATION_TOKEN_INVALID | 422 | The token is unknown, already used, expired, or its phone was never verified | registrationToken | "Your sign-up session has expired. Please verify your phone again." (proposed) | Go back to the phone screen and request a new code |
| EMAIL_IN_USE | 409 | Another rider already has this email | email | "This email is already in use." (proposed) | Highlight the email field; the token is still valid |
| CONFLICT | 409 | A Rider with the session's phone already exists (a parallel registration won) | null | "This can't be done right now. Please refresh and try again." | Restart at the phone screen; verify-otp will log in |
| RATE_LIMITED | 429 | More than 10 registers per hour from one IP | null | "Too many requests. Try again shortly." | Disable the button briefly |
| INTERNAL_ERROR | 500 | A bug or database failure | null | "Something went wrong. Please try again." | Show retry; the token is still valid because the transaction rolled back |

`REGISTRATION_TOKEN_INVALID` and `EMAIL_IN_USE` are new registry rows (see `response-format.md`); `ACCOUNT_EXISTS` is dropped everywhere. `OTP_PROVIDER_ERROR` cannot happen here (no provider call).

## Rate limit, logging and audit
- **Rate limit** (APPROVED): 10 registers per hour per IP, by the in-memory throttler guard described in `rider-send-otp.md` (resets on restart, not shared between instances; client IP per `TRUST_PROXY_HOPS`, decision 123). A guess of the 43-character token is not feasible (256 bits).
- **Log:** `requestId`, code, status. Never the phone, email, name, registration token or its hash, tokens or their hashes, `fcmToken`.
- **Audit events:** no audit table in the MVP (decision 134). One structured log line in the existing key=value style, with the `requestId` and a fixed event name only (`rider.registered`); never ids, phone, email or tokens. `Rider.createdAt`, `Device` and `OtpSession` stay the durable record.

## Admin visibility (CLAUDE.md: the first user-facing domain after the estimate API ships admin endpoints with it)
**Exception recorded in decision 119 (APPROVED, requested by the owner): register ships before admin auth.** The admin endpoints below are written here so they are not lost, and are built when admin authentication exists. Each needs its own doc from the template and owner approval before code (rule 4):

| Endpoint | Returns | Notes |
|---|---|---|
| `GET /v1/admin/riders` | A page of riders: id, fullName, phoneNumber, status, createdAt, lastLoginAt. Filter by status and created-at range. | Paginated (`api-standard.md` section 5); the pagination shape is TO DECIDE (`response-format.md` section 1). Whether the admin sees the full phone or a masked one: TO DECIDE |
| `GET /v1/admin/riders/:id` | One rider plus their devices (platform, appVersion, lastSeenAt, no `fcmToken`) and an OTP summary (counts of sends and locks, no session ids) | The "audit/tracking" view: no new audit table |
| `GET /v1/admin/metrics/riders` | Total riders by status, registrations per day, OTP sent / verified / locked counts for a period | Which "day" (IST or UTC) the buckets use: TO DECIDE |

Until then there is no way to suspend or block a rider through the API (`status` is changed by hand in the database); that is a known limit of shipping first.

## Edge cases and known limitations
- A rider who registers but never receives the reply is recovered by asking for a new code: `verify-otp` then logs them in.
- `registeredCity` and `registeredState` are informational only; they are never used to decide service area.
- The registration token is valid for 10 minutes after verify. A rider who takes longer starts again at `send-otp` (a new SMS).
- A DELETED rider's phone: see Data model, DELETED riders and the unique phone. With the plain unique (decision 128), `verify-otp` gives a DELETED phone `ACCOUNT_BANNED`, so it never reaches register.
- `device.fcmToken` is optional here; a route to set it later is deferred (decision 144).
- SMS, DLT registration and the provider are covered in `rider-send-otp.md`.
- Deferred, not in this feature: ratings and ride counters, block reason and audit columns, referral, UTM, terms and consent, emergency-contact and saved-place endpoints.

## Required tests
- Happy path: 201; Rider `ACTIVE`, `isPhoneVerified` true, `isEmailVerified` false, `isProfileComplete` false, `lastLoginAt` set; the phone equals the verified session's phone; one Device; one RefreshToken whose stored value is the SHA-256 hash and differs from the returned token; the session has `consumedAt`; access token expires in 900 s.
- No token needed (public). Wrong role: not applicable.
- Blocked account: not applicable to register (a SUSPENDED or BLOCKED phone never gets a registration token; see verify-otp).
- Invalid input: every required field missing (REQUIRED); wrong types; `registrationToken` of the wrong length or alphabet; `fullName` of 1 character, 101 characters, with a digit, with a leading space, with a trailing space, with a double space; `email` over 254, with an uppercase letter, with a space, `null`; `registeredCity` as `""`, as a number, over 100 characters; `device` missing, `device.platform` not in the list.
- Unknown field: `phoneNumber`, `otp`, `status`, `role`, `isPhoneVerified`, `isEmailVerified`, `id`, `referralCode`, `utmSource`, an unknown field inside `device`.
- Name rules accept: `Anita Kumari`, `O'Brien`, `O’Brien`, `Dr. Singh`, `Mary-Jane`, a Devanagari name; reject `-Mary`, `Mary-`, `Mary--Jane`, `Anita1`, `Anita  Kumari`, ` Anita`, `Anita `.
- City and state: `null` accepted and stored as null; `"  Ranchi "` stored as `Ranchi`; whitespace-only stored as null; omitted stored as null; a bad city never blocks an otherwise valid registration.
- Registration token: unknown, expired (after 10 minutes), already used, and for a session whose OTP was never verified: each is `REGISTRATION_TOKEN_INVALID`, with identical replies.
- Duplicate call: a second register with the same token is `REGISTRATION_TOKEN_INVALID` and creates nothing.
- Email: an email already used by another rider is `EMAIL_IN_USE` with `field` `email`, the token is not consumed and works again with a different email.
- Phone conflict: a Rider already exists for the session's phone: `CONFLICT`, the token is not consumed.
- Race condition: two simultaneous registers with one token (exactly one 201); two registrations for one phone from two tokens (exactly one 201, the other `CONFLICT`).
- Transaction failure: if the Device insert fails, no Rider, Device, RefreshToken or `consumedAt` remains and the token still works.
- Rate limit: the 11th register from one IP in an hour is `RATE_LIMITED`.
- End to end: send-otp, verify-otp (new phone), register, then logout and a second verify-otp for the same phone returns `isNewRider` false with tokens.
- Secrets: no token, hash or phone in any log line.
- Time: stored timestamps are UTC instants; `rider.createdAt` in the reply is ISO UTC.
- A driver (`DRIVER_AUTH`) session's token is `REGISTRATION_TOKEN_INVALID`.
- A failure at each step of the transaction (consume, create rider, device, refresh token) leaves nothing and the token still works; a unique violation on email or phone that happens after the pre-checks (a parallel registration) becomes `EMAIL_IN_USE` or `CONFLICT` and the token still works.

## Race tests (real Postgres)
The in-memory test database has no row locks and no unique indexes, so the race tests in the list above also run against real Postgres: `src/modules/rider-auth/register.pg.spec.ts`. They are **skipped unless `RUN_PG_TESTS=1`**, so `npm test` stays database-free. They use only a scratch database named `treeps_scratch_register`, a constant in `testing/scratch-db.ts`; only the host, port, user and password are read from `DATABASE_URL`, so they can never open `treeps_db`. They create the scratch database and its tables if missing (the SQL of `prisma/migrations`) and empty its four auth tables before and after.

Run (PowerShell, from the project root; needs `DATABASE_URL` in `.env` and the local Postgres running):
```
$env:RUN_PG_TESTS = '1'; npx vitest run src/modules/rider-auth/register.pg.spec.ts
```
What they prove: two or eight simultaneous registrations with one token give exactly one 201; twenty such rounds never create two riders; two tokens for one phone give one 201 and one `CONFLICT` (the loser's `consumedAt` is rolled back); two tokens for one email give one 201 and one `EMAIL_IN_USE`, and the loser registers afterwards with another email; a failure injected after the rider, device and `consumedAt` were written rolls all of it back. A barrier holds every request until all have passed the pre-checks, so the race is forced inside the transaction, not left to timing.

## Changelog
| Date | What changed | Why |
|---|---|---|
| 2026-10-04 | Draft created with PROPOSED values; schema proposed (not applied) | Rider register docs-first (Step 2) |
| 2026-10-05 | Data model replaced with the owner's final design: `fullName VarChar(100)`, `isEmailVerified`, `OtpSession` with `consumedAt` and registration-token columns, purpose `RIDER_AUTH`; added the Flow note, the name-change SQL and the DELETED / unique-phone options | Final data model from the owner (decisions 100 to 108) |
| 2026-10-05 | Rewritten to the unified flow: register takes a one-time registration token instead of `otp` and `phoneNumber`; Order of operations, Errors, Admin visibility, Edge cases and Required tests rewritten; `ACCOUNT_EXISTS` dropped, `REGISTRATION_TOKEN_INVALID` and `EMAIL_IN_USE` added; token rules moved to `rider-refresh.md` | Owner's flow brief (decisions 109 to 119) |
| 2026-10-05 | Status changed from PROPOSED to APPROVED; DELETED riders keep the plain unique phone and email (decision 128); client IP per `TRUST_PROXY_HOPS` | Owner approval and decisions 120 to 129 |
| 2026-10-05 | device field rules; fullName rule (hyphen out, curly apostrophe in); email rule final; gender values; HS256 JWT; no audit table; config keys; shared types named | Owner decisions 130 to 140 |
| 2026-10-05 | `-` allowed in `fullName` (not first, last or doubled); `appVersion` rule; non-blocking items settled; section 2b approved | Owner decisions 141 to 145 |
| 2026-10-06 | `OtpPurpose` gained `DRIVER_AUTH` | Driver send-otp (decision 150) |
| 2026-10-06 | `OtpPurpose` gained `DRIVER_AUTH` (migration `20261006105503_add_driver_auth_otp_purpose`) | Driver send-otp (decision 150) |
| 2026-10-07 | Built: route, service, DTO, rate limit, tests (in-memory and real-Postgres race tests); the token must belong to a `RIDER_AUTH` session; an expired token is invalid at the exact expiry instant; city and state `""` is `TOO_SHORT`; how a unique violation is recognized; `rider.registered` log line deferred until a request context exists | register code step (decision 151) |
