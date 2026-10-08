# POST /v1/rider/auth/register (complete profile)

Status: BUILT 2026-10-08 on the owner's override (decisions 162 to 165, plus the 2026-10-08 choices in the changelog). Items marked TO DECIDE have no decision yet. A change after approval needs a changelog row. **`GET /v1/rider/me` and `GET /v1/driver/me` are deferred until the driver submit-for-review step; the app reads `status` and `isProfileComplete` from the verify-otp and register replies instead.**

The path `/v1/rider/auth/register` is kept so the route does not move; the controller writes `@Controller('rider/auth')` and never `v1`. **Whether to rename it (for example `PATCH /v1/rider/profile`) now that it only completes a profile: TO DECIDE.** Sibling docs: `rider-send-otp.md`, `rider-verify-otp.md`, `rider-me.md` (deferred), `rider-refresh.md`, `rider-logout.md`.


## Flow (REDESIGNED)
Phone verification happens once. The profile screen can be finished days later, because the rider already has tokens after verify-otp.

```
send-otp -> verify-otp -> (new phone)       Rider created (PROFILE_PENDING) + tokens, isNewRider true
                       -> (existing rider)  login + tokens, isNewRider false
                       -> (SUSPENDED / BLOCKED / DELETED) ACCOUNT_BANNED
GET /v1/rider/me  -> DEFERRED until the driver submit-for-review step; until then the app reads status + isProfileComplete from the verify-otp / register reply
POST /v1/rider/auth/register (access token) -> name + email set, status ACTIVE, isProfileComplete true
refresh: new token pair, rotating        logout: revoke this device's token
```
- `send-otp` never reads the Rider table and replies the same for any phone.
- `verify-otp` checks the OTP and **creates the Rider row** for a new phone (see `rider-verify-otp.md`). There is no registration token any more.
- `register` (this doc) is an **authenticated** call. It needs the access token that `verify-otp` issued. It no longer takes a token, an OTP, a phone or a `device` object: the rider id and the device id come from the access token.

## Purpose
A rider whose phone is verified and whose profile is still empty (status `PROFILE_PENDING`) sets their name and email. In one conditional update the server writes the profile, moves the status to `ACTIVE` and sets `isProfileComplete` to true, and replies with the rider. There is no OTP and no call to the SMS provider at this step. Until the profile is complete the rider has tokens but the app keeps them on the profile screen (what a `PROFILE_PENDING` rider may do on other routes, for example estimate or booking: TO DECIDE, decided when those routes get the guard).

## Who calls it
Rider app, on the profile screen, right after `verify-otp` or on a later day. **Protected endpoint:** a valid access token with `role` `RIDER` is required (this changes the old "public" exception; the JWT guard is described in `rider-me.md`, Gate). Gate checks: JWT guard (token valid, role `RIDER`), throttler guard, validation, status.

## Request fields
Body, JSON. **Nothing else is accepted**; unknown fields (including `registrationToken`, `phoneNumber`, `otp`, `device`, `status`, `isPhoneVerified`, `isEmailVerified`, `isProfileComplete`, `role`, `id`) are rejected with `UNKNOWN_FIELD`. No field is trimmed, lowercased or defaulted silently (`input-validation.md` rule 3).

| Name | Type | Unit | Required? | Allowed range | Why it exists | Why this type/unit | Bucket | What breaks if wrong |
|---|---|---|---|---|---|---|---|---|
| fullName | string | text | Required | 2 to 100 characters (code points; the column is `VarChar(100)`). Only Unicode letters and combining marks, space, `.`, `'`, the curly `’` (U+2019) and `-`. No leading or trailing space, no two spaces in a row; the hyphen may not be first, last or doubled. (decisions 135, 141) | The rider's name shown to drivers; one column instead of first and last | One text field: names do not split reliably into two parts | Input | Unreadable or abusive names; a stray space makes the same name look different |
| email | string | text | Optional | At most 254 characters; shape rule below | Contact and receipts | Text | Input | Bad receipts; duplicate accounts |
| registeredCity | string | text | Optional, may be `null` | 1 to 100 characters | Where the rider registered, from Google Maps | Text as Maps returns it | Input | None for the ride flow: informational, must never block the profile |
| registeredState | string | text | Optional, may be `null` | 1 to 100 characters | As above | As above | Input | As above |

Rules for the rows above (unchanged from the earlier design):
- **Identity:** not in the body. The rider id is the `sub` claim of the access token; the phone is the one stored on that Rider row at verify-otp.
- **fullName:** the `PersonName` type (`input-validation.md` section 2b). Violations are rejected, never fixed. Reasons: `TOO_SHORT`, `TOO_LONG`, and `INVALID_FORMAT` for a disallowed character, a leading or trailing space, or a double space. Letters and combining marks mean Devanagari and other Indian-script names are accepted. The hyphen `-` is allowed (decision 141), but not as the first or last character and not twice in a row. Known limits: a name made only of punctuation passes the character rule, and two spellings of the same accented letter are stored as sent.
- **email:** optional; **omitted means "keep the email as it is"** (nothing is wiped; on the first call that leaves it null). `null` is `WRONG_TYPE` (decision 46), so the email cannot be removed through this route. **A different email than the stored one sets `isEmailVerified` back to false**; the same email sent again leaves it alone. No lowercasing: an address containing an uppercase letter or any space is rejected with `INVALID_FORMAT`, and the app lowercases before sending. Why: Postgres unique is case-sensitive, and because only lowercase gets in, `A@x.com` and `a@x.com` can never be two different stored emails through this API. An email that already belongs to another rider is `EMAIL_IN_USE` (409, `field` `email`), found by the pre-check or, when two calls race, by the unique index. The shape rule is the `Email` type in `input-validation.md` section 2b (decision 136). **Whether email becomes required for a complete profile: TO DECIDE (it is optional, as before).**
- **registeredCity / registeredState:** like email: **sent means saved, omitted keeps the stored value.** A value is trimmed of leading and trailing whitespace before it is stored. `null` and a whitespace-only value are accepted but treated as not sent, so they keep the stored value: **clearing a city or state is not supported for now.** On the first call nothing is stored yet, so omitted leaves them null. An empty string `""` is rejected (`TOO_SHORT`). A wrong type, a value over 100 characters or one containing U+0000 is `INVALID_INPUT`.

Shared types (`input-validation.md` section 2b): `PersonName`, `Email`, `Text` for the city and state, `OptionalNullable`. `OpaqueToken`, `DeviceId`, `AppVersion` and `Nested` are no longer used by this route.

## Response fields
Success: **HTTP 200** (the Rider already exists, so nothing is created; the earlier 201 no longer fits. TO DECIDE: confirm 200). `data` is `{ rider }`, the same `rider` object as `verify-otp` and `GET /v1/rider/me`. There are no `tokens`: the rider already has them.

| Name | Type | Unit | Required? | Allowed range | Why it exists | Why this type/unit | Bucket | What breaks if wrong |
|---|---|---|---|---|---|---|---|---|
| rider.id | string (UUID) | n/a | Always | n/a | The rider's id for later calls | Ids are UUIDs | Identity | App cannot refer to the rider |
| rider.fullName | string or null | text | Always | `null` until the profile is completed; after this call the stored name | Shown in the app | Text | Derived (stored) | Wrong name shown |
| rider.phoneNumber | string | E.164 | Always | as stored | Shown in the app | E.164 | Identity | Wrong number shown |
| rider.email | string or null | text | Always | `null` if none | Shown in the app | Text | Derived (stored) | Wrong email shown |
| rider.registeredCity | string or null | text | Always | as stored | Shown in the app | Text | Derived (stored) | None |
| rider.registeredState | string or null | text | Always | as stored | As above | Text | Derived (stored) | None |
| rider.status | string | enum | Always | `PROFILE_PENDING`, `ACTIVE`, `SUSPENDED`, `BLOCKED`, `DELETED`; after this call `ACTIVE` | App chooses its screen | Enum | Derived | App treats a pending rider as active |
| rider.isPhoneVerified | boolean | n/a | Always | `true` | Confirms the phone was proven | Boolean | Derived | None |
| rider.isEmailVerified | boolean | n/a | Always | `false` (nothing verifies an email in the MVP) | App knows the email is not yet proven | Boolean | Derived | App trusts an unverified email |
| rider.isProfileComplete | boolean | n/a | Always | `false` from verify-otp until this call; `true` after it | App chooses its screen | Boolean | Derived | App skips or repeats the profile screen |
| rider.createdAtIst | string | `dd-mm-yyyy HH:mm:ss`, India time | Always | Example `"07-10-2026 19:23:10"` for `2026-10-07T13:53:10.203Z`. Added by the serializer step (`response-format.md` section 8); additive, so apps bound to `createdAt` keep working and need not format | Display in India | Text | Derived | Wrong time shown |
| rider.createdAt | string | ISO UTC `YYYY-MM-DDTHH:mm:ss.sssZ` | Always | n/a | Member since | UTC per `api-standard.md`; the apps and admin show IST `DD-MM-YYYY HH:MM:SS` | Derived | Wrong "member since" |

Never in the reply: `deletedAt`, `lastLoginAt`, any token or hash, any internal row id other than `rider.id`.

## Derived values
- Server-set when the profile is completed: `status` = `ACTIVE`, `isProfileComplete` = `true`, `updatedAt` = now. `isPhoneVerified` stays `true` and `isEmailVerified` stays `false`. **`isProfileComplete` becoming true here is a change from decision 144** ("nothing in this feature sets it"): the app needs the flag to choose its screen (decision 163).
- The rider id comes from the token, never from the client.
- No new tokens are issued here. For reference, the tokens the rider already holds (issued by verify-otp): the access token is a signed JWT, 15 minutes, algorithm HS256 (decision 133), signed with `JWT_ACCESS_SECRET` (at least 32 characters), issuer `treeps`, claims `sub` (the rider id), `role` (`RIDER`), `deviceId` (the install id), `iat` and `exp`; verification accepts only HS256, never `none`. The refresh token is 32 random bytes (`crypto.randomBytes`, base64url), valid 30 days, only its SHA-256 hash stored; rotation and reuse rules are in `rider-refresh.md`.

## Order of operations
1. JWT guard: valid access token, role `RIDER`; otherwise `UNAUTHORIZED` or `FORBIDDEN`.
2. Throttler guard (IP): 10 per hour per IP (existing `register` limit; whether it should become per rider now: TO DECIDE).
3. Validate the body.
4. Pre-check: another Rider (not the caller) already has this email: `EMAIL_IN_USE` (so a fixable mistake gets a clear answer before the write; the rider's own email is not a clash).
5. One conditional update: set `fullName`, `status` `ACTIVE`, `isProfileComplete` true, plus `email` (with `isEmailVerified` false) when the body sends an email different from the stored one, and `registeredCity` / `registeredState` when the body sends a non-blank value, **where** `id` is the token's rider and `status` is `PROFILE_PENDING` **or `ACTIVE`** (so a second call saves the new values again; owner instruction 2026-10-08). The rider is read first: no row (a token for a deleted rider) is `UNAUTHORIZED`. If the update changes no row, the status is `SUSPENDED`, `BLOCKED` or `DELETED`: `ACCOUNT_BANNED`. A unique violation on email becomes `EMAIL_IN_USE`, read from the violated index name as in decision 151 (`Rider_email_key`). Email, city and state all keep their stored value when omitted.
6. Read the rider back and reply 200 with it.

The write is one statement, so no transaction is needed. Two parallel calls from one rider both succeed and the last write wins; two riders racing for one email give one 200 and one `EMAIL_IN_USE` (the unique index decides; tested on real Postgres).

## Where it lives
`src/modules/rider-auth/`: `register.service.ts` (rewritten: `completeProfile`, the order above), `dto/register.dto.ts` (loses `registrationToken` and `device`), the route in `rider-auth.controller.ts` (`@HttpCode(200)`, behind the JWT guard), `rider-view.ts` (`fullName` nullable). The JWT guard and its decorators are new (see `rider-me.md`, Gate).

## Reference data used
Config values, never hardcoded: access TTL 900 s, refresh TTL 2592000 s, the register rate limit. The registration-token lifetime (600 s) is no longer used.

## State changes
- Before: one Rider `PROFILE_PENDING`, `fullName` and `email` null, `isProfileComplete` false (created by verify-otp). After: the same row with `fullName` (and optional `email`, city, state) set, `status` `ACTIVE`, `isProfileComplete` true. No Device, RefreshToken or OtpSession change.
- Idempotency: calling again is allowed. A second call saves the new values and returns the current rider (200, no error). No `Idempotency-Key` header in the MVP.
- Concurrency: see Order of operations.

## Data stored
`Rider` (updated). Nothing else. Dates are `timestamptz`.

## Data model (FINAL design, 2026-10-05; the migration was applied 2026-10-05)
**Changes for the 2026-10-07 redesign (NOT applied, no migration yet, owner approval and a backup first, CLAUDE.md rule 7):**
- `enum RiderStatus` gains `PROFILE_PENDING`. A new rider row is created with it (verify-otp sets it explicitly). Whether it should also become the column default: TO DECIDE (today the default is `ACTIVE`, which would make a row created without a status look complete).
- `Rider.fullName` becomes nullable: `String? @db.VarChar(100)` (was required). Null until the profile is completed; the API's `rider.fullName` is `string or null`.
- `Rider.email` was already nullable; `isProfileComplete` already exists (default false) and is now set true by `register`.
- `OtpSession.registrationTokenHash` and `registrationExpiresAt` are **no longer written**. Dropping them (and their unique index) is a later migration: TO DECIDE (drop now, or keep unused until a use appears). No row has a value in them today except riders who verified and never registered, which a drop would lose; check first.
- No other table changes. The existing block below is the schema as applied before the redesign.
The owner fixed this design on 2026-10-05 (decisions 100 to 108); the flow that uses it is in decisions 109 to 119. Nothing here changes `prisma/` yet. The block was checked with `prisma validate` on a scratch copy outside the repo (valid) and nothing was run against the database. The owner types it into `prisma/models/` later. Conventions kept: text uuid ids (`@default(uuid())`), camelCase, no `@@map`, enum values uppercase. Rider keeps every existing column that is not listed as changed (`email`, `profilePicture`, `isProfileComplete`, `createdAt`, `updatedAt`, the `SavedPlace` and `EmergencyContact` relations).

```prisma
enum RiderStatus {
  PROFILE_PENDING // added by the 2026-10-07 redesign (not applied)
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
  fullName          String?            @db.VarChar(100) // nullable since the 2026-10-07 redesign (not applied)
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
| fullName | `String @db.VarChar(100)`, required (replaces `firstName` + `lastName`); **nullable after the 2026-10-07 redesign** | One name field; the database also enforces the 100-character limit (Postgres counts characters, matching the code-point rule of the API) |
| status | enum `RiderStatus`, default `ACTIVE` (`PROFILE_PENDING` added by the redesign) | Lets an admin suspend or block a rider and lets a soft delete exist |
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
| OtpSession | One row per OTP sent. `phoneNumber`; `purpose` (`RIDER_AUTH` or `DRIVER_AUTH`; the driver value was added by migration `20261006105503_add_driver_auth_otp_purpose`); `providerSessionId` (provider session id, server only, never returned); `attempts` (default 0); `expiresAt` (send time + 5 min); `verifiedAt` (set once, by a conditional update, when the provider confirms the code: this makes the OTP single use); `consumedAt` (set when the session is finished: login tokens issued, a banned login refused, or registration done); `registrationTokenHash` and `registrationExpiresAt` (**unused since the 2026-10-07 redesign**, see above); `createdAt`. Index `(phoneNumber, createdAt)`. Meanings are APPROVED, as set by the flow in this doc |
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
`phoneNumber` is `@unique` for every row, so a rider whose status is `DELETED` keeps the number and that phone can never register again (verify-otp would find a DELETED Rider and refuse it). `email` has the same property. **Decision 128 (APPROVED): keep the plain unique.** A DELETED rider keeps their phone and email for good; verify-otp answers `ACCOUNT_BANNED` for that phone, so it never reaches register. No delete flow exists yet, so this costs nothing today. Anonymizing on delete and a partial unique index were considered and are not used (a partial index is raw SQL that Prisma cannot express and may try to drop). Revisit when a delete or restore flow is built.

Other schema points (decision 144):
- `isProfileComplete` is set true by `register` (redesign, decision 163); it was `false` for ever under the earlier design.
- No retention or cleanup of `OtpSession` and revoked `RefreshToken` rows in the MVP; they are kept.
- Deferred, not in this feature (decision 108): ratings and ride counters, block reason and audit columns, referral, UTM, terms and consent, `profilePhotoKey`, `preferredLanguage`, `signupSource`, `registrationIpHash`, `tokenVersion`, emergency-contact and saved-place endpoints.

## Errors
All errors use the envelope in `standards/response-format.md`.

| Code | HTTP status | When it happens | `field` marker | Rider-safe message | How the app UI should react |
|---|---|---|---|---|---|
| INVALID_INPUT | 400 | Missing, wrong type, wrong format, too short or long, or unknown field (`details` lists all) | first invalid field | "Please check your input." | Highlight the fields in `details` |
| UNAUTHORIZED | 401 | No `Authorization: Bearer` header, a malformed, wrongly signed, wrong-issuer or expired access token; or the rider no longer exists | null | "Please log in again." | Try `refresh`; if that fails, start phone login again |
| FORBIDDEN | 403 | A valid token whose `role` does not match the route domain (a `DRIVER` token on `/v1/rider/*`, a `RIDER` token on `/v1/driver/*`) | null | "You don't have access to this." | Treat as a bug; log out |
| ACCOUNT_BANNED | 403 | The rider is SUSPENDED, BLOCKED or DELETED | null | "This account can't book rides." (proposed) | Show support contact |
| EMAIL_IN_USE | 409 | Another rider already has this email | email | "This email is already in use." (proposed) | Highlight the email field |
| CONFLICT | 409 | Not raised by this route any more (a second call is accepted) | null | n/a | n/a |
| RATE_LIMITED | 429 | More than 10 calls per hour from one IP | null | "Too many requests. Try again shortly." | Disable the button briefly |
| INTERNAL_ERROR | 500 | A bug or database failure | null | "Something went wrong. Please try again." | Show retry; nothing was written |

`REGISTRATION_TOKEN_INVALID` is **removed**: nothing uses it any more (decision 162). `ACCOUNT_EXISTS` stays dropped. `OTP_PROVIDER_ERROR` cannot happen here (no provider call).

## Rate limit, logging and audit
- **Rate limit:** 10 per hour per IP by the in-memory throttler guard described in `rider-send-otp.md` (resets on restart, not shared between instances; client IP per `TRUST_PROXY_HOPS`, decision 123).
- **Log:** `requestId`, code, status. Never the phone, email, name, tokens or their hashes.
- **Audit events:** no audit table in the MVP (decision 134). One structured log line (`rider.profile_completed`) once a request context exists (TRACKER); never ids, phone, email or tokens. `Rider.updatedAt` is the durable record.

## Admin visibility (CLAUDE.md: the first user-facing domain after the estimate API ships admin endpoints with it)
The exception of decision 119 still applies: the admin endpoints are written here so they are not lost, and are built when admin authentication exists. Each needs its own doc and owner approval before code (rule 4). **New with the redesign:** riders now exist before their profile does, so the admin views must show `PROFILE_PENDING` riders and how long they have been pending.

| Endpoint | Returns | Notes |
|---|---|---|
| `GET /v1/admin/riders` | A page of riders: id, fullName (may be null), phoneNumber, status, createdAt, lastLoginAt. Filter by status (including `PROFILE_PENDING`) and created-at range. | Paginated; the pagination shape is TO DECIDE. Whether the admin sees the full phone or a masked one: TO DECIDE |
| `GET /v1/admin/riders/:id` | One rider plus their devices (platform, appVersion, lastSeenAt, no `fcmToken`) and an OTP summary (counts, no session ids) | The audit/tracking view: no new audit table |
| `GET /v1/admin/metrics/riders` | Total riders by status, signups per day, **profile completion rate (ACTIVE / all verified)**, OTP sent / verified / locked counts | Which "day" (IST or UTC) the buckets use: TO DECIDE |

Until then there is no way to suspend or block a rider through the API.

## Edge cases and known limitations
- A rider who verifies but never completes the profile stays `PROFILE_PENDING` for good. There is no cleanup in the MVP (TO DECIDE: expire or remove abandoned rows). They hold their phone, so a later verify-otp for that phone logs them in and the app sends them to the profile screen.
- A rider who verifies on a second device before completing the profile gets another Device and tokens; either device may complete the profile.
- `registeredCity` and `registeredState` are informational only; never used to decide service area.
- A DELETED rider's phone: see Data model, DELETED riders and the unique phone. verify-otp gives it `ACCOUNT_BANNED`.
- The profile can be sent again; `fullName` is replaced each time; email, city and state are replaced only when sent (email: and only when different, then `isEmailVerified` resets). They cannot be cleared through this route. Other profile edits (photo, gender) need a profile-update API (not built, no doc).
- `device.fcmToken` is set at verify-otp; a route to change it later is deferred (decision 144).
- Access tokens stay valid for up to 15 minutes after a ban (stateless JWT, decision 144), so a banned rider with a live token passes the guard until it expires; the conditional update still refuses the write.
- SMS, DLT registration and the provider are covered in `rider-send-otp.md`.

## Required tests
- Happy path: a `PROFILE_PENDING` rider with a valid access token sends `fullName`: 200; the rider is `ACTIVE`, `isProfileComplete` true, `fullName` stored, `isPhoneVerified` true, `isEmailVerified` false; no Device or RefreshToken is created; `updatedAt` moved.
- Optional fields: `email`, `registeredCity`, `registeredState` stored when sent; city `"  Ranchi "` stored as `Ranchi`; omitted on a new profile stays null; on a later call omitted, `null` and whitespace-only keep the stored value; a bad city never blocks an otherwise valid call; a changed email resets `isEmailVerified`, the same or an omitted email does not.
- Auth: no token, a malformed token, a token signed with another secret, an expired token and an `alg: none` token each give `UNAUTHORIZED`; a `DRIVER` token gives `FORBIDDEN`; a token for a rider id that no longer exists gives `UNAUTHORIZED`. The body's `phoneNumber` or `id` is `UNKNOWN_FIELD`.
- Invalid input: `fullName` missing, 1 character, 101 characters, with a digit, a leading space, a trailing space, a double space; `email` over 254, with an uppercase letter, with a space, `null`; city as `""`, a number, over 100 characters.
- Unknown field: `registrationToken`, `device`, `phoneNumber`, `otp`, `status`, `isProfileComplete`, `role`, `id`.
- Name rules accept: `Anita Kumari`, `O'Brien`, `O’Brien`, `Dr. Singh`, `Mary-Jane`, a Devanagari name; reject `-Mary`, `Mary-`, `Mary--Jane`, `Anita1`, `Anita  Kumari`, ` Anita`, `Anita `.
- Status rules: an `ACTIVE` rider may call again and gets 200 with the new values saved; SUSPENDED, BLOCKED and DELETED riders get `ACCOUNT_BANNED` and nothing changes.
- Email: an email used by another rider is `EMAIL_IN_USE` with `field` `email`, the rider stays `PROFILE_PENDING` and can retry with another email; a unique violation raised by the database (a parallel call) is also `EMAIL_IN_USE`.
- Second call: a second call with new values returns 200 and the stored values are the new ones.
- Race condition (real Postgres, `register.pg.spec.ts`): two riders completing with one email give exactly one 200 and one `EMAIL_IN_USE` (also 8 at once); one rider calling twice at once with the same email gets two 200s; a changed email resets `isEmailVerified`, an omitted one is kept; the database unique is case-sensitive.
- Rate limit: the 11th call from one IP in an hour is `RATE_LIMITED`.
- End to end: send-otp, verify-otp (new phone) gives tokens and a `PROFILE_PENDING` rider, register with the access token gives `ACTIVE` and `isProfileComplete` true (built as a test).
- Secrets: no token, hash or phone in any log line.
- Time: stored timestamps are UTC instants; `rider.createdAt` is ISO UTC and `rider.createdAtIst` is its India-time twin.

## Race tests (real Postgres)
`src/modules/rider-auth/register.pg.spec.ts` (rewritten 2026-10-08 for the email race; the registration-token race tests are gone). Scratch database `treeps_scratch_register`, only with `RUN_PG_TESTS=1`; the scratch-database safety rules do not change. The test holds every caller at `rider.updateMany` so the race happens at the write.

## Changelog
| Date | What changed | Why |
|---|---|---|
| 2026-10-04 | Draft created with PROPOSED values; schema proposed (not applied) | Rider register docs-first (Step 2) |
| 2026-10-05 | Data model replaced with the owner's final design: `fullName VarChar(100)`, `isEmailVerified`, `OtpSession` with `consumedAt` and registration-token columns, purpose `RIDER_AUTH`; added the Flow note, the name-change SQL and the DELETED / unique-phone options | Final data model from the owner (decisions 100 to 108) |
| 2026-10-05 | Rewritten to the unified flow: register takes a one-time registration token instead of `otp` and `phoneNumber`; Order of operations, Errors, Admin visibility, Edge cases and Required tests rewritten; `ACCOUNT_EXISTS` dropped, `REGISTRATION_TOKEN_INVALID` and `EMAIL_IN_USE` added; token rules moved to `rider-refresh.md` | Owner's flow brief (decisions 109 to 119) |
| 2026-10-05 | Status changed from PROPOSED to APPROVED; DELETED riders keep the plain unique phone and email (decision 128); client IP per `TRUST_PROXY_HOPS` | Owner approval and decisions 120 to 129 |
| 2026-10-05 | device field rules; fullName rule (hyphen out, curly apostrophe in); email rule final; gender values; HS256 JWT; no audit table; config keys; shared types named | Owner decisions 130 to 140 |
| 2026-10-05 | `-` allowed in `fullName` (not first, last or doubled); `appVersion` rule; non-blocking items settled; section 2b approved | Owner decisions 141 to 145 |
| 2026-10-06 | `OtpPurpose` gained `DRIVER_AUTH` (migration `20261006105503_add_driver_auth_otp_purpose`) | Driver send-otp (decision 150) |
| 2026-10-07 | Built (registration-token design): route, service, DTO, rate limit, tests (in-memory and real-Postgres race tests) | register code step (decision 151) |
| 2026-10-07 | **Redesigned: register is now an authenticated complete-profile call.** No `registrationToken` or `device` in the body; 200 with `{ rider }`; `PROFILE_PENDING` to `ACTIVE`; `isProfileComplete` set true; `REGISTRATION_TOKEN_INVALID` removed; `UNAUTHORIZED`, `FORBIDDEN`, `ACCOUNT_BANNED` added; Rider `fullName` nullable and `RiderStatus` gains `PROFILE_PENDING` (Data model, not applied). The code still follows the old design | Owner instruction of 2026-10-07 (decisions 162 to 165) |
| 2026-10-08 | **Built.** JWT access-token guard (`src/common/auth/jwt-auth.guard.ts`: signature, issuer `treeps`, expiry, role must match the route domain: 401 `UNAUTHORIZED`, 403 `FORBIDDEN`); register is now `completeProfile` behind the guard, 200; a second call saves the new values again instead of `CONFLICT` (owner instruction); `registrationToken` code, `REGISTRATION_TOKEN_INVALID` and `OtpProviderNotBuiltError` removed; `GET /me` for rider and driver deferred until the driver submit-for-review step | Owner override of 2026-10-08 |
| 2026-10-08 | Omitted email is kept (not wiped); a changed email resets `isEmailVerified`; email-unique race tested on real Postgres; known limit: the guard does not check account status (decision 168) | Owner instruction of 2026-10-08 (decision 167 amended) |
| 2026-10-08 | City and state follow the email rule: sent means saved, omitted (or null / blank) keeps the stored value; clearing is not supported | Owner instruction of 2026-10-08 (decision 167 amended) |
