# POST /v1/rider/auth/verify-otp

Status: APPROVED (owner, 2026-10-05). Items still marked TO DECIDE must be resolved in this doc before the code that needs them is written (CLAUDE.md rule 12). A change after approval needs a changelog row.

Part of the unified phone-OTP flow (see the diagram in `rider-send-otp.md`). The path `/v1/rider/auth/verify-otp` is APPROVED; the controller writes `@Controller('rider/auth')` and never `v1`.

## Purpose
The rider types the code they received. The server checks it with the OTP provider. If the phone already has an ACTIVE rider, this is **login**: the reply carries the tokens. If the phone is unknown, the reply says `isNewRider: true` and gives a one-time registration token that `register` needs. A SUSPENDED or BLOCKED rider is refused.

## Who calls it
Rider app, after `send-otp`. Public endpoint (no token, no role; an explicit exception to the gate in `api-standard.md` section 1). The Rider role is attached to the token this API issues. Gate checks: validation, per-phone limit, OTP.

## Request fields
Body, JSON. Nothing else is accepted; unknown fields (including `status`, `role`, `purpose`) are rejected with `UNKNOWN_FIELD`. Nothing is trimmed, lowercased or defaulted silently.

| Name | Type | Unit | Required? | Allowed range | Why it exists | Why this type/unit | Bucket | What breaks if wrong |
|---|---|---|---|---|---|---|---|---|
| phoneNumber | string | E.164 text | Required | `+91` + 10 digits, first of the 10 in 6 to 9 (same rule as `send-otp`) | Finds the OTP session and the rider | One canonical spelling per number | Identity | Wrong session or account |
| otp | string | digits as text | Required | Exactly 6 characters, digits 0 to 9 only | Proves the rider holds the phone | Text, not a number: a leading zero must survive (`012345`) | Input | A number type would drop the leading zero and fail a real rider |
| device | object | n/a | Required | Fields below; no unknown fields at any depth | Lets the server bind tokens to one device | Nested object | Input | Tokens cannot be bound to a device |
| device.deviceId | string | text | Required | 1 to 64 characters, only `A-Z a-z 0-9 _ -` (decision 132) | App-generated install id; one refresh token per device | Text | Identity | Two devices share one token |
| device.platform | string | enum | Required | `ANDROID`, `IOS` | Admin and push routing | Enum, uppercase | Input | Wrong push channel |
| device.appVersion | string | text | Required | three dot-separated numbers like `1.4.2`, 1 to 3 digits each (decision 143) | Support and force-update | Text | Input | Cannot tell which build has a bug |
| device.fcmToken | string | text | Optional | 1 to 512 characters (decision 132); never logged | Push notifications | Text | Input | No push messages |

`device.*` uses the dot-path field names of `input-validation.md` section 4. The `device` shape is the same in `register` (brief listed deviceId, platform and appVersion; `fcmToken` stays optional as decided earlier, decision 94).

Shared types (`input-validation.md` section 2b): `IndianMobile`, `OtpCode`, `DeviceId`, `AppVersion`, `Text` for `fcmToken`, `OneOf` for `platform`.

## Response fields
Success: HTTP 200 in both cases (APPROVED; a login creates no resource, and the new-rider case creates only a server-side session). The app switches on `isNewRider`. `data` has one of two shapes:

**A. Login (a rider exists and is ACTIVE)**

| Name | Type | Unit | Required? | Allowed range | Why it exists | Why this type/unit | Bucket | What breaks if wrong |
|---|---|---|---|---|---|---|---|---|
| isNewRider | boolean | n/a | Always | `false` | Tells the app which shape follows | Boolean discriminator | Derived | App parses the wrong shape |
| rider | object | n/a | Always | Same fields as `rider` in `rider-register.md` Response fields | App shows the rider | Same object everywhere | Derived | Inconsistent profile |
| tokens | object | n/a | Always | Same fields as `tokens` in `rider-register.md` Response fields (access 15 min, refresh 30 days) | Authenticates later calls | Same object everywhere | Derived | Rider cannot call APIs |

**B. Unknown phone (no rider)**

| Name | Type | Unit | Required? | Allowed range | Why it exists | Why this type/unit | Bucket | What breaks if wrong |
|---|---|---|---|---|---|---|---|---|
| isNewRider | boolean | n/a | Always | `true` | Tells the app to show the sign-up form | Boolean discriminator | Derived | App parses the wrong shape |
| registrationToken | string | opaque text | Always | 43 characters, base64url of 32 random bytes (encoding APPROVED) | One-time pass for `register`; it is how the server remembers the verified phone | Opaque random value | Derived | Anyone could register any phone |
| registrationTokenExpiresInSeconds | integer | seconds | Always | 600 | App knows how long the sign-up form may take | Seconds, no clock parsing | Reference (config) | Form fails at the end |

Never in the reply: the provider session id, `attempts`, any token hash, the rider's `deletedAt` or `lastLoginAt`.

## Order of operations
1. Validate the body.
2. **Per-phone limit (decision 121):** at most 10 verify attempts per phone per hour, counted from the `attempts` of that phone's `OtpSession` rows created in the last hour, so the count survives a restart and works across instances. Over the limit: `RATE_LIMITED`, no provider call. There is no per-IP limit on this route in the MVP.
3. Load the newest `OtpSession` for this phone:
   - none, or already used (`verifiedAt` set): `OTP_INVALID`;
   - `expiresAt` passed: `OTP_EXPIRED`;
   - `attempts` already 5: `OTP_ATTEMPTS_EXCEEDED`.
4. **Reserve one attempt atomically**: one conditional update (`attempts + 1` where `attempts < 5`, `verifiedAt` is null and not expired). If no row changed, another request got there first: re-read and return the right code from step 3. Why: twenty parallel guesses must not all pass the check before any is counted.
5. Ask the OTP provider to verify (5 s timeout, no retry, never inside a DB transaction).
   - Provider failure: give the attempt back, reply `OTP_PROVIDER_ERROR`.
   - `MISMATCH`: keep the attempt, reply `OTP_INVALID`. After the 5th wrong code the next call gets `OTP_ATTEMPTS_EXCEEDED`.
6. Mark the code used with a conditional update (`verifiedAt` null becomes now). If it matches no row, another request used it first: `OTP_INVALID`. This is the **single-use** step.
7. Look up the Rider by phone. Only now, after the caller proved they hold the phone, does the account state matter:
   - **No rider:** create a registration token (32 random bytes from `crypto.randomBytes`, base64url), store only its SHA-256 hash in `registrationTokenHash` and `registrationExpiresAt` = now + 10 min on this session, reply shape B. `consumedAt` stays null.
   - **ACTIVE:** one database transaction: upsert the `Device` (create it, or update `appVersion`, `platform`, `lastSeenAt`, and `fcmToken` if sent); revoke the device's earlier unrevoked `RefreshToken` rows; create the new `RefreshToken` (SHA-256 hash only); set `Rider.lastLoginAt`; set the session's `consumedAt`. Then sign the access token and reply shape A.
   - **SUSPENDED or BLOCKED:** set `consumedAt`, reply `ACCOUNT_BANNED`. No tokens.
   - **DELETED:** set `consumedAt`, reply `ACCOUNT_BANNED`, no tokens. A DELETED row keeps owning its phone (plain unique, decision 128), so the phone cannot register again. Revisit when a delete or restore flow is built.

## Derived values
- `isNewRider`, the rider object and the tokens are computed by the server. The client sends no status or role.
- Access token: signed JWT, 15 minutes, HS256, claims `sub`, `role`, `deviceId` (full rules in `rider-register.md` Derived values, decision 133). Refresh token: 32 random bytes, base64url, 30 days, only its SHA-256 hash stored. Both as in `rider-register.md`.

## Reference data used
OTP numbers and provider timeout as in `rider-send-otp.md`. Registration-token lifetime 600 seconds, access 900 seconds, refresh 2592000 seconds (all config, never hardcoded). New environment variables need a rule in `input-validation.md` section 6 and a line in `.env.example` in the same commit.

## State changes
- Before: one open `OtpSession`. After (login): `verifiedAt` and `consumedAt` set, one `Device` row (new or updated), one new `RefreshToken`, the old one for that device revoked, `Rider.lastLoginAt` updated. After (new rider): `verifiedAt` set, `registrationTokenHash` and `registrationExpiresAt` set, no Rider yet.
- Idempotency: natural, not replayable. The code is single use, so a repeated call gets `OTP_INVALID`. If the reply is lost, the rider asks for a new code. No `Idempotency-Key` header in the MVP.
- Concurrency: the conditional attempt update and the conditional `verifiedAt` update make exactly one concurrent request win. Two devices logging in at once get separate `Device` rows (unique `(riderId, deviceId)`).
- If the transaction in step 7 fails after step 6, the code is already used and the rider asks for a new one. Accepted: marking and issuing are not combined because the provider call cannot be inside the transaction.

## Data stored
`OtpSession` (updated), `Device`, `RefreshToken` (hash only), `Rider.lastLoginAt`. The registration token is stored only as a hash. The OTP and the provider session id are never in a reply or log. No limit on devices per rider in the MVP (decision 144).

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
| INTERNAL_ERROR | 500 | A bug or a database failure | null | "Something went wrong. Please try again." | Show retry |

## Rate limit, logging and audit
- Rate limit (decision 121): 10 verify attempts per phone per hour, on top of the per-session cap of 5 wrong attempts. At most 10 guesses per phone per hour against 1,000,000 possible codes. No per-IP limit on this route in the MVP.
- Log: `requestId`, code, status. Never the phone, the OTP, tokens, token hashes, `fcmToken`, the provider session id or URL.
- Audit events: no audit table in the MVP (decision 134). One structured log line per event in the existing key=value style, with the `requestId` and a fixed event name only (`login.succeeded`, `otp.locked`, `login.banned`, `registration_token.issued`); never the phone or ids. They can also be derived from `OtpSession`, `Device` and `Rider.lastLoginAt`.

## Edge cases and known limitations
- This route reveals whether a phone has an account (`isNewRider`, `ACCOUNT_BANNED`), but only to someone who proved they hold the phone.
- A rider who is SUSPENDED or BLOCKED still costs an SMS at `send-otp` (that route never reads the Rider table).
- A login on a new device creates another `Device` and token; the old device's token is not touched (one token per device, not per rider).
- Access tokens already issued stay valid until they expire (15 minutes) even after a ban. Reducing that window with the deferred `tokenVersion` column is not done in the MVP (decision 144).
- The registration token is only usable once, within 10 minutes (see `rider-register.md`).

## Required tests
- Happy path, login: ACTIVE rider, correct code: 200, `isNewRider` false, rider and tokens present; one Device row; `RefreshToken` stores the SHA-256 hash and differs from the returned token; session `verifiedAt` and `consumedAt` set; `lastLoginAt` set.
- Happy path, new phone: 200, `isNewRider` true, `registrationToken` present (43 characters), no Rider created, `registrationTokenHash` stored (not the token), `consumedAt` null.
- No token needed (public). Wrong role: not applicable.
- Blocked account: SUSPENDED and BLOCKED riders get `ACCOUNT_BANNED`, no tokens, no Device or RefreshToken row, `consumedAt` set. DELETED gets `ACCOUNT_BANNED` the same way (confirmed, decision 138).
- Invalid input: missing fields, `otp` as a number, `otp` of 5 or 7 characters or with a letter, phone without `+91`, `device` missing, `device.platform` not in the list.
- Unknown field: `status`, `role`, `purpose`, an unknown field inside `device`.
- OTP: wrong code is `OTP_INVALID` and `attempts` goes up by 1; the 6th call after 5 wrong codes is `OTP_ATTEMPTS_EXCEEDED`; an expired session is `OTP_EXPIRED`; no session is `OTP_INVALID`; a used session is `OTP_INVALID`; an older session after a newer send is not accepted.
- Duplicate call: repeating a successful verify gets `OTP_INVALID` and issues nothing.
- Race condition: two simultaneous verifies with one correct code (exactly one succeeds); 20 parallel wrong guesses never exceed 5 attempts.
- Device rules: a second login from the same device revokes the first token and leaves one unrevoked token; a login from a new device leaves both devices' tokens valid.
- Upstream failure: provider timeout, error and unreadable reply each give `OTP_PROVIDER_ERROR`, the attempt is given back, nothing is issued, and the provider is called exactly once.
- Transaction failure: if the Device insert fails, no RefreshToken or `consumedAt` remains.
- Rate limit: the 11th verify attempt for one phone in an hour is `RATE_LIMITED` and calls the provider zero times.
- Secrets: no OTP, session id, token hash or provider URL in any reply or log line.

## Changelog
| Date | What changed | Why |
|---|---|---|
| 2026-10-05 | Draft created: login, new-rider and banned branches; registration token | Owner's unified flow brief |
| 2026-10-05 | Status changed from PROPOSED to APPROVED; verify-otp limited to 10 per phone per hour (replaces the open IP limit); DELETED riders get `ACCOUNT_BANNED` (plain unique phone) | Owner approval and decisions 120 to 129 |
| 2026-10-05 | device field rules; HS256 JWT claims; no audit table; DELETED confirmed as `ACCOUNT_BANNED`; shared types named | Owner decisions 130 to 140 |
| 2026-10-05 | `appVersion` rule; devices per rider, ban wording and token window settled (decision 144) | Owner decisions 141 to 145 |
