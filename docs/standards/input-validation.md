# Input Validation

Status: Draft

Every value a client sends is checked before any handler runs. A failed check replies with INVALID_INPUT (see `response-format.md`).

## 1. Rules
1. **Every API declares its own allowed fields in a DTO class.** Why: the API doc and the code list the same fields, and nothing undeclared gets through.
2. **Unknown fields are rejected, in the body, the query and the path, at any depth.** This includes nested objects and list items (for example `pickup.foo`) and unknown query parameters. Reason `UNKNOWN_FIELD`. Why: it blocks a client sending a fake price, role or status.
3. **No silent type coercion.** A string is never turned into a number, a number never into a string, and nothing is trimmed, lowercased or given a default silently. Any default is a documented rule in the API doc. Why: a value changed on the way in may not mean what the client sent. **Exception (owner, 2026-10-10, decision 182): the profile text fields of `POST /v1/rider/auth/register` (`fullName`, `email`, `registeredCity`, `registeredState`, `registeredAddress`) go through the `Normalize` step below before they are checked. Nothing else is cleaned.**
4. **Query and path values arrive as text.** Each one that must be a number is converted by an explicit converter (`ToInt` in `src/common/validation/`). It accepts only plain decimal digits and leaves anything else unchanged, so validation rejects it. The API doc names every converted field. Why: the conversion is visible and strict, unlike Nest's own conversion.
5. **Path, query and body values are read through a DTO object** (`@Param() params: Dto`, `@Query() query: Dto`, `@Body() body: Dto`). These patterns are banned in non-spec files under `src/`:
   - the built-in `Parse*Pipe`s: `ParseIntPipe`, `ParseFloatPipe`, `ParseBoolPipe`, `ParseArrayPipe`, `ParseUUIDPipe`, `ParseEnumPipe`;
   - named extraction: `@Param('x')`, `@Query('x')`, `@Body('x')`.

   A test (`src/common/validation/banned-patterns.spec.ts`) scans for them. No file is on the allowlist today (the old `src/auth/auth.controller.ts` entry was removed with the Firebase code, decision 146); the mechanism stays for owner-approved exceptions.
   Why: Nest silently converts primitive-typed parameters (`''` becomes 0, `'0x10'` becomes 16, any Boolean that is not `'true'` becomes false), the built-in pipes cannot name the failing field, and a named body value skips the DTO rules entirely.
6. **The shared field types in section 2 are the only way to declare these fields.** The general-purpose validators `IsLatitude`, `IsLongitude`, `IsNumberString` and `IsISO8601` are not used directly. Why: `IsLatitude` accepts the string "12.5" and `IsISO8601` accepts time-zone offsets and date-only strings, which the rules below forbid.
7. **The reply never contains library text or the submitted value.** Each invalid field gets one fixed reason code (section 3). Why: library messages can change or reveal internals, and submitted values can be phone numbers or tokens.
8. **A client-sent derived value (price, distance, ETA, status, earnings) is an unknown field.** Why: the server computes derived values.
9. **A required field that is missing gives REQUIRED, never WRONG_TYPE.** The shared required types include `IsDefined`. Why: the app needs to know the field is absent, not that its type is wrong.
10. **Optional means "may be omitted".** `null` on an optional field is WRONG_TYPE unless the API doc marks the field nullable. `IsOptional` is not used for this, because it also lets `null` through. Why: `null` is a value the client chose to send and must not pass silently.
11. **A body is unusable only if it is missing, `null`, an array, or a bare string, number or boolean.** An unusable body gives INVALID_INPUT with `field` null and `details` omitted, and never crashes. Why: there is no field to point at, so a `details` entry would invent one; and a malformed request must always get the standard reply. **An empty object `{}` is a normal body** and is validated by the DTO, so the reply lists the missing required fields. Why: `{}` is well formed, and naming the missing fields tells the app more than a blanket error.
12. **Each API doc resolves the shared-type limits it uses before its code is written.** Every TO DECIDE in section 2 that the API needs (phone countries, money maximum, date range, page maximums, text lengths) is set in that API's doc. Why: the docs-first rule; code must not invent limits.
13. **Raw request access is banned in non-spec files under `src/`: `@Req()`, `@Request()`, `@Res()`, `@Response()` and `@Headers()`.** The same test scans for them, and the same allowlist applies (empty today, decision 146). The authenticated user will come from a guard plus a custom parameter decorator, decided in F4. Why: `@Req()`, `@Request()` and `@Headers()` hand out raw input that bypasses the DTO, and `@Res()` and `@Response()` bypass the response envelope (decision 35).
14. **Every `@Body()`, `@Query()` and `@Param()` has a DTO class with at least one rule, and no such DTO sets a default value.** This is checked when the server starts, in `main.ts`, after the modules are created and before `listen()`, so before `PrismaService.onModuleInit` and so before any database connection. It is also checked in a CI test over the real routes (`src/common/validation/real-routes.spec.ts`). A violation stops the server from starting, and the message lists each problem by controller and handler (never request data). Missing decorator metadata also stops it. `ROUTE_INPUT_ALLOWLIST` is empty today (its only entry, `AuthController.login`, was removed with the Firebase code, decision 146); an allowlist entry that matches no route is an error. Only top-level route DTOs are checked for defaults, not nested DTOs. Why: Nest skips validation silently for an interface, an inline type, `unknown`, a primitive, or a class imported with `import type`; and a value set inside a DTO is a silent default (rule 3), because it satisfies "required" without the client sending anything.

## 2. Shared field types
| Type | Rule | Reason on failure | Why |
|---|---|---|---|
| lat | JSON number, finite, -90 to 90 inclusive. An API adds its own service-area bounds in its doc. | REQUIRED, WRONG_TYPE, OUT_OF_RANGE | Degrees are the map unit; a string such as "12.5" is not a number |
| lng | JSON number, finite, -180 to 180 inclusive. An API adds its own service-area bounds in its doc. | REQUIRED, WRONG_TYPE, OUT_OF_RANGE | As lat |
| phone | String in E.164 form: `+` then digits, no spaces or punctuation, not normalized. Allowed countries and length limits: the rider APIs use `IndianMobile` (section 2b); other uses: TO DECIDE. | REQUIRED, WRONG_TYPE, INVALID_FORMAT | One canonical form, so the same number always matches the same account |
| money | JSON integer, in paise, 0 or more. Maximum: TO DECIDE. | REQUIRED, WRONG_TYPE, OUT_OF_RANGE | Integer paise avoids floating point errors (decision 9). Negative amounts are derived values, never client input |
| date | String in UTC: `YYYY-MM-DDTHH:mm:ss`, optional `.` and 1 to 3 digits, then `Z`. Must be a real calendar date and time. No offsets, no date-only. Years 0000 to 0099 are not accepted (JavaScript reads them as 1900 to 1999, so they cannot round-trip). Earliest and latest allowed values: TO DECIDE, set per API as functions. | REQUIRED, WRONG_TYPE, INVALID_FORMAT, OUT_OF_RANGE | UTC only, so the server never guesses a time zone |
| uuid | String in UUID form. Versions accepted (any version, or v4 only): TO DECIDE. | REQUIRED, WRONG_TYPE, INVALID_FORMAT | Ids are UUIDs |
| page | JSON integer or converted query value, 1 or more. Maximum page and default when omitted: TO DECIDE. | REQUIRED, WRONG_TYPE, OUT_OF_RANGE | Lists are paginated |
| pageSize | Integer, 1 or more, at most the maximum. Maximum and default: TO DECIDE. | REQUIRED, WRONG_TYPE, OUT_OF_RANGE | A cap keeps one request from reading a whole table |
| text | String with a minimum and maximum length set per field in the API doc (no default), counted in Unicode code points (an emoji counts as 1). The character U+0000 is rejected. No trimming. | REQUIRED, WRONG_TYPE, INVALID_FORMAT, TOO_SHORT, TOO_LONG | Code points match how users and Postgres count characters; Postgres cannot store U+0000 in text, so it is refused before it becomes a 500. Length limits bound storage and reply size |

A number that is not an integer where an integer is required counts as WRONG_TYPE.

## 2b. New shared types for the rider auth APIs
Needed by `api/rider-send-otp.md`, `rider-verify-otp.md`, `rider-register.md`, and `rider-logout.md` (rule 12: these limits are resolved before the code is written). Like every shared type, each returns a `FieldType` and becomes a decorator only through `Required(...)` or `Optional(...)` (decision 49), checks run in the reason order of section 3, and none trims, lowercases or converts. All rules in this section are APPROVED (decision 145); rules the owner stated word for word are marked **(owner)**.

| Type | Rule | Reasons on failure | Valid examples | Invalid examples |
|---|---|---|---|---|
| IndianMobile | String, exactly `+91` then 10 digits, the first of the 10 in 6 to 9. ASCII digits only, nothing trimmed. Regex `^\+91[6-9][0-9]{9}$`. **(owner)** A separate type in `src/common/validation/fields.ts` (built); the generic `Phone()` stays for other uses. | REQUIRED, WRONG_TYPE, INVALID_FORMAT | `+919876543210` | `9876543210` (no `+91`), `+915876543210` (starts with 5), `+9198765432` (short), `+449876543210` (not India), `+919876543210 ` (trailing space), a number type (WRONG_TYPE) |
| Email | String, at most 254 characters (TOO_LONG). INVALID_FORMAT if it contains any whitespace, if lowercasing would change it (so any uppercase letter, ASCII or not), or if it is not `local@domain`: exactly one `@`, a non-empty local part, a domain with at least one `.` and no empty part, no leading or trailing `.` in the domain. No further checks (no DNS, no allow-list of characters). **(owner)** exactly one `@`, a dot in the domain, no spaces, no uppercase, at most 254 characters; the app lowercases first. The non-empty local part and the dot-placement checks are extra and approved with decision 145. | REQUIRED, WRONG_TYPE, INVALID_FORMAT, TOO_LONG | `anita@example.com`, `a.b+tag@mail.example.in` | `Anita@example.com` (uppercase), `anita @example.com` (space), `anita@example` (no dot), `anita@@example.com`, `@example.com`, `anita@.com`, 255 characters (TOO_LONG) |
| PersonName | String of 2 to 50 characters (code points) with at least 2 letters (`\p{L}`), after `Normalize` (decision 182; was 2 to 100). Every character is a Unicode letter (`\p{L}`), a combining mark (`\p{M}`), a space (U+0020), `.`, `'`, `’` (U+2019) or `-`. Leading, trailing and doubled spaces are fixed by `Normalize` before the check, so they never reach it. The hyphen may not be the first or the last character and may not appear twice in a row (`--`). U+0000 is rejected as in `Text`. Regex with the `u` flag `^[\p{L}\p{M} .'’-]+$`, plus the space and hyphen checks. **(owner)** the hyphen is allowed; rejecting a leading, trailing or doubled hyphen is decision 141. | REQUIRED, WRONG_TYPE, INVALID_FORMAT, TOO_SHORT, TOO_LONG | `Anita Kumari`, `O'Brien`, `O’Brien`, `Dr. Singh`, `Mary-Jane`, `अनीता कुमारी` | `A` (TOO_SHORT), 101 characters (TOO_LONG), `Anita  Kumari` (double space), ` Anita`, `Anita `, `-Mary` (leading hyphen), `Mary-` (trailing hyphen), `Mary--Jane` (double hyphen), `Anita1` (digit), `Anita\tKumari` (tab), `Anita😀` (emoji) |
| OtpCode | String of exactly 6 ASCII digits, regex `^[0-9]{6}$`. A string, never a number, so a leading zero survives. **(owner)** | REQUIRED, WRONG_TYPE, INVALID_FORMAT | `012345`, `123456` | `12345`, `1234567`, `12a456`, `١٢٣٤٥٦` (non-ASCII digits), `123456` sent as a JSON number (WRONG_TYPE) |
| OpaqueToken | String of exactly 43 characters from `A-Z a-z 0-9 _ -` (base64url of 32 random bytes), regex `^[A-Za-z0-9_-]{43}$`. The shape of the session token. No route validates it as input now (the session guard looks the token up; the refresh route and the registration token are gone), so the type is kept as a shared type. **(owner)** 43 characters and base64url | REQUIRED, WRONG_TYPE, INVALID_FORMAT | `abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO_-` (43 characters) | 42 or 44 characters, a `+` or `/` or `=` (standard base64), a space |
| DeviceId | String of 1 to 64 characters, only `A-Z a-z 0-9 _ -`, regex `^[A-Za-z0-9_-]+$` with the length checked first. **(owner)** | REQUIRED, WRONG_TYPE, INVALID_FORMAT, TOO_SHORT, TOO_LONG | `9f2c1b7e-3a4d-4c55-8e21-0d6f5a1b2c3d`, `abc_123` | `""` (TOO_SHORT), 65 characters (TOO_LONG), `device 1` (space), `dev:1` |
| AppVersion | String of 1 to 20 characters from `A-Z a-z 0-9 . + _ -`, pattern `^[0-9A-Za-z.+_-]{1,20}$` (so `1.4.2`, `1.4.2+37`, `2.0.0-beta.1`). `""` is TOO_SHORT, 21 characters TOO_LONG, any other character INVALID_FORMAT. **(owner, 2026-10-10, decision 181)** This replaces the three-dotted-numbers rule of decision 143. | WRONG_TYPE, INVALID_FORMAT, TOO_SHORT, TOO_LONG | `1.4.2`, `1.4.2+37`, `2.0.0-beta.1` | `1.4 2`, `v1.4.2/x`, `""`, 21 characters |
| FcmToken | String of 1 to 512 characters with no whitespace of any kind and no U+0000. Used as `OptionalNullable(FcmToken())`; the device DTO turns `""` into "not sent" before the check, so an empty push token never fails a login (decision 181). The value is never logged, returned or put in `details` (details carry the field name only). | WRONG_TYPE, INVALID_FORMAT, TOO_SHORT, TOO_LONG | a 163-character FCM token | `has space`, 513 characters |
| Address | String of at most 150 characters (code points); only Unicode letters (`\p{L}`), combining marks (`\p{M}`), decimal digits (`\p{Nd}`), space and `, . - / # ( )`. Used after `Normalize`; a blank value is "not sent". **(owner, 2026-10-10, decision 182)** | WRONG_TYPE, INVALID_FORMAT, TOO_LONG | `12/B, Main Road (near Park) #4` | `Flat 4 <b>`, `St. Mary's` (the apostrophe is not allowed), 151 characters |
| Normalize(options) | Not a type but a step that runs before the checks (a class-transformer `@Transform`, `src/common/validation/fields.ts`): NFC, runs of U+0020 collapsed to one space, leading and trailing whitespace removed, then optionally lowercase (`email`) or Title Case (`registeredCity`, `registeredState`). A text with nothing left becomes "not sent" (`undefined`), or stays `""` for `fullName` so it fails as REQUIRED. Only strings are touched; a number or `null` reaches the checks and fails there. A newline, tab or zero-width character inside the text is not touched, so the character rule still rejects it. **(owner, 2026-10-10, decision 182)** | n/a | `  Anita   Kumari ` becomes `Anita Kumari`; `ASHA@Example.com` becomes `asha@example.com`; `ranchi` becomes `Ranchi` | n/a |

Built in `src/common/validation/fields.ts` (all with specs): `IndianMobile`, `OtpCode`, `DeviceId`, `AppVersion`, `Email`, `PersonName`, `OpaqueToken`. Two helpers for nullable optional text, built with register: `OptionalNullable(type)` (omitted and `null` both skip every check; used only where an API doc marks a field nullable, rule 10) and the `Text` option `emptyIsTooShort` (an optional field's `""` is `TOO_SHORT`; the default stays `REQUIRED`). `CalendarDate({ min, max })` (built for `api/driver/driver-onboarding-submit.md`, with a spec): a string `YYYY-MM-DD` that is a real calendar date, read as midnight UTC, years before 1900 refused, no time and no offset; reasons `WRONG_TYPE`, `INVALID_FORMAT`, `OUT_OF_RANGE`; `min` and `max` are functions, read on every request, and a broken pair stops the server at startup. Used for `dateOfBirth` (18 to 80 years old) and `expiryDate` (today to 50 years ahead): the limits are proposals, TO DECIDE. Known mismatch, not changed: `device.fcmToken` uses plain `Text`, so `""` gives `REQUIRED` while the `fcmToken` row above says `TOO_SHORT` (TO DECIDE).

Also used, already existing: `OneOf(['ANDROID', 'IOS'])` for `device.platform`, `Nested(() => DeviceDto)` for `device`, and `Text({ min: 1, max: 100 })` for `registeredCity` and `registeredState` (the server trims these two before storing, a documented normalization in `rider-register.md`).

## 3. Reason codes (`details[].reason`)
Fixed codes, UPPER_SNAKE_CASE, never renamed once an app ships. The apps localize on them (same rule as error codes).

| Code | Used when |
|---|---|
| REQUIRED | The field is missing, null, or an empty string where a value is required |
| UNKNOWN_FIELD | The field is not declared for this API |
| WRONG_TYPE | The value has the wrong JSON type, or is not an integer where one is required |
| INVALID_FORMAT | Right type, wrong shape (UUID, phone, UTC date, pattern) |
| OUT_OF_RANGE | A number is outside its allowed bounds |
| NOT_ALLOWED | The value is not in the allowed set |
| TOO_SHORT | Text or a list is shorter than its minimum |
| TOO_LONG | Text or a list is longer than its maximum |
| INVALID_VALUE | Any other failed check (fallback; never library text) |

One reason per field. When several checks fail on one field, the first code in this order wins: REQUIRED, UNKNOWN_FIELD, WRONG_TYPE, INVALID_FORMAT, OUT_OF_RANGE, NOT_ALLOWED, TOO_SHORT, TOO_LONG, INVALID_VALUE.

## 4. Field names
- A field is named as the client sent it, camelCase.
- A nested field is a dot path from the root: `pickup.lat`. A list item uses its index: `stops.0.lat`.
- Path and query values use their own name (`id`, `page`). The source (body, query, path) is not part of the name, so an API must not use the same field name in two sources.
- Why: the name alone tells the app which input to highlight.

## 5. Order, size and unsafe names in `details`
- `details` is sorted A to Z by `field` (plain code-unit order). `field` on the error is the first entry of `details` that is not `$unknown`, or null if there is none. Why: `field` lets the app highlight one input, and `$unknown` is not an input.
- `details` holds at most 20 entries, applied after sorting. The request is rejected either way. Why: one request must not produce a huge reply.
- The name of an unknown field is echoed only if it matches `^[A-Za-z_][A-Za-z0-9_.]{0,63}$`. All other unknown names collapse into ONE entry `{ "field": "$unknown", "reason": "UNKNOWN_FIELD" }`. Because `$` sorts before letters, that entry comes first in `details`, but `field` skips it: `field` is the first real invalid field, or null if `$unknown` is the only entry. Why: a name chosen by the client is never reflected into a reply unless it looks like a normal field name.

## 6. Startup configuration
Checked when the server starts, before it accepts requests. Failure stops the process with a message that names the variable and a reason code, never its value.

| Variable | Rule | Reasons |
|---|---|---|
| DATABASE_URL | Required. Must start with `postgresql://` or `postgres://` (any letter case), contain no control character (newline, NUL, anything below U+0020) and no leading or trailing space, and parse as a URL. | REQUIRED, INVALID_FORMAT |
| PORT | Optional, default 3000. Plain decimal digits with no leading zero (empty, `080`, `+80`, spaces and non-ASCII digits are refused), 1 to 65535. Converted to a number explicitly. | INVALID_FORMAT, OUT_OF_RANGE |
| NODE_ENV | Required. One of `development`, `test`, `production`, exact and case-sensitive. No default. | REQUIRED, NOT_ALLOWED |
| OTP_PROVIDER | Required, no default. Exactly `twofactor` or `fake` (exact, case-sensitive). Refused with `fake` when `NODE_ENV` is `production`, even if `ALLOW_FAKE_OTP` is `true`. | REQUIRED, NOT_ALLOWED |
| ALLOW_FAKE_OTP | Optional, no default, read only when `OTP_PROVIDER` is `fake`. With `fake` it must be exactly `true`: no value or an empty value is REQUIRED, any other value is NOT_ALLOWED, and either stops startup. | REQUIRED, NOT_ALLOWED |
| FAKE_OTP_CODE | Required only when `OTP_PROVIDER` is `fake`, no default. Exactly 6 ASCII digits. Never printed. | REQUIRED, INVALID_FORMAT |
| TWOFACTOR_API_KEY | Required only when `OTP_PROVIDER` is `twofactor`, no default. Non-empty, no control character, no leading or trailing space. Never printed. | REQUIRED, INVALID_FORMAT |
| TWOFACTOR_TEMPLATE | Optional, default `OTP1`; read only when `OTP_PROVIDER` is `twofactor`. 1 to 50 characters from letters, digits, `_` and `-`. | INVALID_FORMAT |
| TRUST_PROXY_HOPS | Optional, default 0 (untrusted: the connection's own address is the client IP and forwarded headers are ignored). Plain decimal digits with no leading zero except `0` itself, 0 to 10 (the cap of 10 is a sanity limit chosen here). Converted to a number explicitly. | INVALID_FORMAT, OUT_OF_RANGE |
| TERMS_VERSION | Optional, default `2026-10-v1`. A short label for the terms of use in force: 1 to 32 characters from `A-Z a-z 0-9 . _ -`. Stored on a rider with `termsAcceptedAt` when the profile is completed (decision 180; this overrides decision 139 for this one value). | INVALID_FORMAT |
| STORAGE_DRIVER | Optional outside production, default `local` (the `storage/` folder). `local` or `s3`, exact. In production it is REQUIRED and must be `s3`: `local` there is NOT_ALLOWED (decision 189), because a server disk can be wiped and the photos are identity documents. | REQUIRED, NOT_ALLOWED |
| S3_BUCKET | Read only when `STORAGE_DRIVER=s3`, then required. 3 to 63 characters: lower-case letters, digits, `.` and `-`, starting and ending with a letter or digit. | REQUIRED, INVALID_FORMAT |
| S3_REGION | Read only when `STORAGE_DRIVER=s3`, then required. A region such as `ap-south-1`, or `auto` (Cloudflare R2). | REQUIRED, INVALID_FORMAT |
| S3_ENDPOINT | Read only when `STORAGE_DRIVER=s3`. Optional; only for an S3-compatible service other than AWS. An `https` address with no user name or password in it. | INVALID_FORMAT |

All problems are reported together in one message, for example `Invalid environment configuration: DATABASE_URL (REQUIRED), PORT (OUT_OF_RANGE). See ...`. The code is `src/config/env.validation.ts`, wired through `ConfigModule.forRoot({ validate })`.

### Startup database check
After the app is created and the route input check has passed, and before `listen()`, the server opens one connection with the `pg` client, runs `SELECT 1`, and closes it (`src/config/database-check.ts`).
- **Limit: 5 seconds** for the whole check. A host that never answers stops startup instead of hanging.
- **Any failure** (wrong password, unreachable host, timeout, a connection string the driver refuses) gives the same fixed message: `Database check failed: could not run a test query using DATABASE_URL (the database is unreachable within 5 seconds, or it refused the connection). Check that the database is running and that the host, port, user, password and database name in DATABASE_URL are right.` The error has no cause and carries no input; driver text can hold the username, the host or the password, so it is never kept or printed.
- Closing the client is best effort (1 second) and never changes the result.
- It checks that the database answers. It does not check that migrations are applied (backlog).

### How a failed start ends
`main.ts` sends every startup failure, including an unhandled rejection, to `refuseToStart` (`src/config/startup-failure.ts`). It prints ONE line to stderr and exits with code 1:
- an `EnvConfigError`, a `DatabaseCheckError`, a `RouteInputsError` or an `OtpProviderNotBuiltError` (our own types) prints its own message, which is built from variable names, controller and handler names, reason codes and constants, never from a value;
- anything else (a library error, a string, an object, `undefined`) prints only `Startup failed. See server logs for details.`
- The server does not rely on Node's default unhandled-rejection behavior, so `NODE_OPTIONS=--unhandled-rejections=warn` cannot turn a refused start into a running server.

- **The owner must add `NODE_ENV=development` to the local `.env`, and the new rider auth keys (`OTP_PROVIDER` and what it needs), or the server refuses to start.** The agent never edits `.env`.
- A new environment variable needs a rule here and a line in `.env.example` in the same commit. The six rider auth keys above (`OTP_PROVIDER`, `ALLOW_FAKE_OTP`, `FAKE_OTP_CODE`, `TWOFACTOR_API_KEY`, `TRUST_PROXY_HOPS`) have their rules here now; their `.env.example` lines are added in the code commit. A cross-variable rule (the fake provider) is reported with the same message format, naming the variable and a reason code, never the value.
- Why NODE_ENV has no default: a missing value must stop startup instead of silently choosing a mode.

## 7. Known behavior
Nest drops prototype keys (such as `__proto__`) from a request before validation. They are removed silently and are not reported as UNKNOWN_FIELD. This is expected; do not write a test that expects an error for them.

## Changelog
| Date | What changed | Why |
|---|---|---|
| 2026-09-29 | Draft created | F3.3 docs-first |
| 2026-09-29 | `field` skips the `$unknown` entry; an unusable body has `field` null and no `details` | Owner decisions before commit |
| 2026-09-30 | Text counts code points and rejects U+0000; years 0000 to 0099 rejected; `{}` is a normal body | F3.3 piece c (validation building blocks) |
| 2026-09-30 | Raw request access banned (rule 13); banned-patterns test named in rule 5 | F3.3 piece d1 (input validation pipe) |
| 2026-09-30 | Section 6: DATABASE_URL prefix and control-character rules, PORT rejects empty and leading zeros, startup database check, how a failed start ends | F3.3 piece e (config validation) |
| 2026-09-30 | Startup route input check and DTO initializer check (rule 14) | F3.3 piece d2 |
| 2026-10-05 | Section 2b: new shared types for the rider auth APIs (IndianMobile, Email, PersonName, OtpCode, OpaqueToken, DeviceId, AppVersion, fcmToken limits); section 6: six startup keys (OTP_PROVIDER, ALLOW_FAKE_OTP, FAKE_OTP_CODE, TWOFACTOR_API_KEY, TRUST_PROXY_HOPS, JWT_ACCESS_SECRET) | Rider auth docs approved; rule 12 (decisions 139 and 140) |
| 2026-10-05 | PersonName allows `-` (not first, last or doubled); AppVersion regex is `^\d{1,3}\.\d{1,3}\.\d{1,3}$`; section 2b approved | Owner decisions 141 to 145 |
| 2026-10-05 | Section 6 keys implemented in `src/config/env.validation.ts` with a drift-guard test over each row; reasons for `ALLOW_FAKE_OTP` spelled out | Rider auth config step |
| 2026-10-05 | `IndianMobile` built in `fields.ts` with its spec | Rider auth shared types |
| 2026-10-07 | `Email`, `PersonName` and `OpaqueToken` built; `OptionalNullable` and the `Text` option `emptyIsTooShort` added for the nullable city and state of register | Register code step (decision 151) |
| 2026-10-09 | Section 6: `JWT_ACCESS_SECRET` removed (no JWT any more, decision 178); `OpaqueToken` is only a shared type now | Server-side sessions |
| 2026-10-10 | Rule 3 exception for the register profile fields (`Normalize`); `PersonName` 2 to 50 with 2 letters; `AppVersion` pattern loosened; `FcmToken` and `Address` types; `Normalize` step; startup key `TERMS_VERSION` | Owner instruction of 2026-10-10 (decisions 180 to 182) |
| 2026-10-16 | New shared type `CalendarDate` (date without time) | Driver onboarding needs birth and expiry dates, which `date` (a full UTC time) cannot express |
| 2026-10-16 | Section 6: startup keys `STORAGE_DRIVER`, `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`. The AWS keys are read by the AWS client itself (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`), not by our validation | Owner chose S3 for the driver photos (decision 189) |
