# POST /v1/rider/auth/send-otp

Status: APPROVED (owner, 2026-10-05). Items still marked TO DECIDE must be resolved in this doc before the code that needs them is written (CLAUDE.md rule 12). A change after approval needs a changelog row.

Part of one phone-OTP flow with four sibling docs: `rider-verify-otp.md`, `rider-register.md`, `rider-refresh.md`, `rider-logout.md`. All paths are `/v1/rider/auth/<name>` (APPROVED). The `/v1` prefix is added by `setupApp`; the controller writes `@Controller('rider/auth')` and never `v1`.

```
send-otp -> verify-otp -> (existing rider) tokens                 = login
                       -> (unknown phone) registrationToken -> register -> tokens
refresh: new token pair, rotating        logout: revoke this device's token
```

## Purpose
A person who wants to log in or register as a rider asks for a code to prove they own a phone number. This API asks the SMS provider (2Factor, AUTOGEN mode) to send a 6-digit code and remembers, on the server only, which provider session belongs to it. It **never reads the Rider table** and gives the **same reply for every phone**, so it cannot be used to find out which numbers have accounts. It creates no account and issues no token.

## Who calls it
Rider app, at the start of login or registration. Public endpoint: no token, no role (an explicit exception to the "valid token required" gate in `api-standard.md` section 1). Gate checks: rate limit and validation only.

## Request fields
Body, JSON. Only the field below is accepted; unknown fields (including `purpose`, `otp`) are rejected with `UNKNOWN_FIELD`.

| Name | Type | Unit | Required? | Allowed range | Why it exists | Why this type/unit | Bucket | What breaks if wrong |
|---|---|---|---|---|---|---|---|---|
| phoneNumber | string | E.164 text | Required | `+91` followed by 10 digits, first of the 10 in 6 to 9 (APPROVED). Nothing is trimmed or normalized. | Identifies who is logging in or registering and where the SMS goes | The repo's `phone` type is E.164 and not normalized, so one number has one spelling and always matches one account | Identity | A malformed number wastes a paid SMS; two spellings of one number could create two accounts |

The OTP purpose is never a request field. Every session has the purpose `RIDER_AUTH`, the only value of the `OtpPurpose` enum (a driver flow would add its own value later).

Phone rule: the field uses the `IndianMobile` type (`input-validation.md` section 2b): `+91`, then 10 digits, the first in 6 to 9. The existing generic `Phone()` is not used here.

Shared types (`input-validation.md` section 2b): `IndianMobile`.

## Response fields
Success: HTTP 200 (APPROVED). `data` is:

| Name | Type | Unit | Required? | Allowed range | Why it exists | Why this type/unit | Bucket | What breaks if wrong |
|---|---|---|---|---|---|---|---|---|
| expiresInSeconds | integer | seconds | Always | 300 | App shows how long the code lives | Seconds avoid time-zone and clock-skew parsing | Reference (config) | App shows a wrong countdown |
| resendAfterSeconds | integer | seconds | Always | 30 | App disables "resend" until the cooldown ends | As above | Reference (config) | App lets the rider tap resend and get RATE_LIMITED |

The reply is identical for every phone. The 2Factor session id is never returned, logged or echoed. The OTP value is never known to the server (AUTOGEN: the provider generates and checks it).

## Derived values
- `expiresInSeconds`, `resendAfterSeconds`: constants from config, not computed per request.
- Order of checks (cheapest first, so a paid SMS is the last step):
  1. IP throttler guard (before any work).
  2. Body validation.
  3. Per-phone limits from `OtpSession` rows: cooldown, then hourly count.
  4. Call the OTP provider.
  5. Store the new `OtpSession`.
  6. Reply.
- The Rider table is not read, so a SUSPENDED, BLOCKED or DELETED phone still gets an SMS. Their account state is checked at verify-otp, after the rider proves they hold the phone. Refusing here would reveal that the phone has an account.

## Reference data used
All tunable values come from config, never hardcoded (`api-standard.md` section 2). Limits and lifetimes are constants in one config file, not environment variables (decision 139). The environment keys are listed under Startup rules.

| Value | Proposed value |
|---|---|
| OTP length | 6 digits, as text (confirmed in M0) |
| OTP lifetime | 5 minutes |
| Max wrong attempts | 5 per session, then locked (used by verify-otp) |
| Resend cooldown | 30 seconds per phone |
| Max sends per phone | 5 per hour |
| Max sends per IP | 20 per hour |
| Provider timeout | 5 seconds, no automatic retry |

## OTP provider (shared with verify-otp)
The code never calls 2Factor directly. It depends on an `OtpProvider` interface (an interface is a TypeScript contract; in Express terms, a service object you can swap with a mock). APPROVED:

| Method | What it does | Result |
|---|---|---|
| `send(phoneNumber)` | Asks the provider to send an OTP | `{ providerSessionId }`, or a provider failure |
| `verify(providerSessionId, otp)` | Asks the provider if the code matches | `true` (match) or `false` (no match); a provider failure is a thrown error |

Two implementations:
- **TwoFactorOtpProvider (real):** 5 second timeout, **no automatic retry** (a retry can send a second SMS), any failure (timeout, refusal, unreadable reply) becomes `OTP_PROVIDER_ERROR` (503). Its exact request format, session-id field and error shapes: confirmed in M0 (not guessed in these docs).
- **Built so far (send-otp step):** the `OtpProvider` interface, `FakeOtpProvider`, and the choice by `OTP_PROVIDER` at startup, all in `src/modules/rider-auth/otp/`. With `OTP_PROVIDER=twofactor` the app refuses to start with the fixed message `OTP_PROVIDER=twofactor: twofactor client not built yet (blocked on M0). ...` (an `OtpProviderNotBuiltError`, which the startup printer may show because it holds a key name and constants only). It never falls back to the fake.
- **FakeOtpProvider (dev and test only):** makes no network call. `send` returns a made-up session id; `verify` returns `MATCH` only for one fixed code taken from config (no default value).

Startup rules (final key names, decision 139: `OTP_PROVIDER`, `ALLOW_FAKE_OTP`, `FAKE_OTP_CODE`, `TWOFACTOR_API_KEY`, `TRUST_PROXY_HOPS`; the exact rules are in `input-validation.md` section 6, and each key gets a line in `.env.example` in the code commit):
- `OTP_PROVIDER` is required, with no default, and is `twofactor` or `fake`.
- **The fake provider needs two deliberate settings: `OTP_PROVIDER=fake` AND `ALLOW_FAKE_OTP=true`.** `ALLOW_FAKE_OTP` has no default and is read only when the provider is `fake`; with `OTP_PROVIDER=fake` and any other value or no value, the app refuses to start.
- **The app refuses to start if the fake provider is selected and `NODE_ENV` is `production`**, even with `ALLOW_FAKE_OTP=true` (reason code `NOT_ALLOWED`, the variable named, no value printed).
- `TWOFACTOR_API_KEY` is required when `twofactor` is selected; `FAKE_OTP_CODE` (6 digits) is required when `fake` is selected.
- `TRUST_PROXY_HOPS`: see Rate limit. It is optional, a whole number, and defaults to 0.
- Residual risk: the double gate stops an accidental fake provider, but a deployed `development` server with both variables set would still accept the fixed code, and anyone who knows it could log in as any phone. Keep both variables out of every deployed environment file.

## State changes
- Before: no active session for this phone. After: one new `OtpSession` row (`phoneNumber`, `purpose` `RIDER_AUTH`, `providerSessionId`, `attempts` 0, `expiresAt` = now + 5 min; `verifiedAt`, `consumedAt`, `registrationTokenHash`, `registrationExpiresAt` all null).
- **Only the newest session for a phone is valid.** A new send makes all older ones unusable. No extra column is needed: verify-otp reads the row with the latest `createdAt`.
- Idempotency: natural. A repeat call inside the cooldown is `RATE_LIMITED` and sends nothing. There is no `Idempotency-Key` header in the MVP.
- Concurrency: two simultaneous sends for one phone could both pass the cooldown check and send two SMS. No mitigation in the MVP: the rare duplicate SMS is accepted because the hourly cap still holds (decision 144).
- A session is stored only after the provider accepts the request. If the provider fails or times out nothing is stored.

## Data stored
`OtpSession` only (model in `rider-register.md`, Data model). Stored at send time: phone, purpose, provider session id, attempts (0), expiry, created time. The other columns are filled by later steps. Not stored: the OTP itself.
No retention or cleanup of old `OtpSession` rows in the MVP (decision 144).

## Errors
All errors use the envelope in `standards/response-format.md`. Messages come only from the registry.

| Code | HTTP status | When it happens | `field` marker | Rider-safe message | How the app UI should react |
|---|---|---|---|---|---|
| INVALID_INPUT | 400 | Missing, wrong type, wrong format or unknown field (`details` lists every field) | first invalid field | "Please check your input." | Highlight the phone field |
| RATE_LIMITED | 429 | IP limit, 30-second cooldown, or 5 per hour per phone exceeded | null | "Too many requests. Try again shortly." | Disable the button for `resendAfterSeconds`, then retry |
| OTP_PROVIDER_ERROR | 503 | The provider timed out (5 s), refused, or returned something we cannot read | null | "We couldn't reach the code service. Please try again." (proposed) | Show retry; do not auto-retry |
| INTERNAL_ERROR | 500 | A bug or a database failure | null | "Something went wrong. Please try again." | Show retry |

`OTP_PROVIDER_ERROR` is 503 (decision 130); 503 is in the status table of `response-format.md` section 4.

## Where it lives
`src/modules/rider-auth/`: `rider-auth.controller.ts` (`@Controller('rider/auth')`, `@RateLimit` 20 per IP per hour from `RATE_LIMITS`), `rider-auth.service.ts`, `dto/send-otp.dto.ts` (`IndianMobile`), `rider-auth.module.ts`. The service takes the time from an injectable clock (`src/common/clock.ts`) and stores `createdAt` from it, so the cooldown and hourly counts use one timeline. The provider is called before the row is stored, as in the order of checks above (the row needs the provider's session id).

## Rate limit, logging and audit
- **Rate limit** (APPROVED): 5 sends per hour per phone, 30-second cooldown per phone, 20 per hour per IP.
  - Per-phone limits are counted from `OtpSession` rows, so they survive a restart and work across several server instances.
  - The per-IP limit is an **in-memory throttler guard** (no Redis exists in the repo). It resets when the server restarts and is not shared between instances, so with N instances the real limit is up to N times higher. It is hand-written, with no new dependency (decision 147): the `@RateLimit({ name, ip?, phone? })` decorator in `src/common/rate-limit/` attaches the guard to a route, and the numbers are constants in `src/config/rate-limits.ts`. A fixed window is used, so a client can use up to twice the limit around a window edge. Expired counters are swept, so the map cannot grow forever.
  - Reading the client IP needs raw request access, which is banned in controllers (`input-validation.md` rule 13). It happens inside the guard.
  - **Client IP source (decision 123):** the guard reads the proxy header only if `TRUST_PROXY_HOPS` is set. The default is 0, which means untrusted: the IP is the connection's own address and any forwarded header is ignored (so a client cannot spoof it). With N hops the header is counted from the nearest proxy, N hops deep (the Express `trust proxy` hop count; mechanism confirmed when built).
  - Consequence: behind a load balancer with `TRUST_PROXY_HOPS` left at 0, every rider shares the balancer's address, so the per-IP limits throttle everyone together. Set it to the real number of proxies in each environment.
  - The decorator attaches the guard itself (`@UseGuards`), so there is no `APP_GUARD` and no extra setup in `setupApp` or in test modules; only the global `RateLimitModule` (imported by `AppModule`) must be present.
  - Per-phone limits for send-otp and verify-otp are counted by the services from `OtpSession` rows (durable), not by this guard. The guard can also count per phone, read from the body's `phoneNumber` before validation (guards run before the pipe), and only when it is exactly in the `IndianMobile` shape; this is not used by any route in the docs.
  - A blocked request replies `RATE_LIMITED` (429) in the standard envelope. No `Retry-After` header is sent: the docs do not say to (TO DECIDE).
- **Log:** `requestId`, error code, status. Never the phone number, the provider session id, the API key or the provider's URL (the 2Factor API key can sit inside the request URL).
- **Audit events** (`api-standard.md` section 6): no audit table in the MVP (decision 134). The service writes one structured log line per event in the existing key=value style, with the `requestId` and a fixed event name only (`otp.sent`); never the phone number or ids. The `OtpSession` rows are the durable record.

## Edge cases and known limitations
- Because this route never reads the Rider table and replies the same for every phone, it cannot be used to test which phone numbers have accounts. verify-otp reveals it only after the caller proves they hold the phone.
- If the provider times out after actually sending the SMS, the rider receives a code but no session exists, so verify-otp fails with `OTP_INVALID`. The rider taps resend. Accepted limitation of "no retry".
- SMS delivery in India needs DLT registration (the reason recorded in decision 77). Who registers, the sender id and the template: TO DECIDE. Outside the code, but it blocks real SMS.
- The provider costs money per SMS; a spend alarm is set in the provider's account by the owner, not in code (decision 144).
- This endpoint is public, so the rate-limit guard must be attached to it before deployment.

## Required tests
- Happy path: 200, `expiresInSeconds` 300, `resendAfterSeconds` 30; one `OtpSession` row with purpose `RIDER_AUTH`; the reply has no session id.
- Same reply for a phone with a Rider (ACTIVE, SUSPENDED, BLOCKED, DELETED) and a phone without one; the Rider table is never queried.
- No token needed (public). Wrong role and blocked account: not applicable here (see verify-otp).
- Invalid input: missing phone, a number as the phone, `9876543210` (no `+91`), `+919876543210 ` (trailing space), `+915876543210` (starts with 5), `+9198765432` (too short), `+449876543210` (not India).
- Unknown field: `purpose`, `otp`, anything else.
- Duplicate call: a second send inside 30 seconds is `RATE_LIMITED`, calls the provider zero times, stores no row.
- Hourly limit: the 6th send in an hour for one phone is `RATE_LIMITED`.
- IP limit: the 21st send from one IP in an hour is `RATE_LIMITED`.
- Race condition: two simultaneous sends (behavior per the decision above).
- Upstream failure: provider timeout, error and unreadable reply each give `OTP_PROVIDER_ERROR` and store nothing; the provider is called exactly once (no retry).
- Newest session wins: after two sends, only the second session is accepted by verify-otp (tested there).
- Provider selection: the fake provider makes no network call; the app refuses to start with the fake provider and `NODE_ENV=production`, or with `OTP_PROVIDER=fake` and `ALLOW_FAKE_OTP` not `true`; a missing provider setting stops startup.
- No secret in any reply or log line.

## Changelog
| Date | What changed | Why |
|---|---|---|
| 2026-10-04 | Draft created with PROPOSED values | Rider register docs-first (Step 2) |
| 2026-10-05 | One unified route for login and register: purpose `RIDER_AUTH` (was `RIDER_REGISTER`); `ACCOUNT_EXISTS` check removed; the Rider table is not read | Final data model from the owner |
| 2026-10-05 | Unified flow with five routes; `OtpProvider` interface with a real and a fake implementation and the startup refusal; in-memory IP throttler; same reply for any phone | Owner's flow brief |
| 2026-10-05 | Status changed from PROPOSED to APPROVED; the fake provider needs `OTP_PROVIDER=fake` and `ALLOW_FAKE_OTP=true` and is refused in production; client IP read only when `TRUST_PROXY_HOPS` is set; the 2Factor request format is confirmed in M0 | Owner approval and decisions 120 to 129 |
| 2026-10-05 | 503 for `OTP_PROVIDER_ERROR`; final config keys; `IndianMobile` type; no audit table, structured log with `requestId` only | Owner decisions 130 to 140 |
| 2026-10-05 | concurrent sends, retention and spend alarm settled (decision 144); 2Factor details still confirmed in M0 and DLT registration still open | Owner decisions 141 to 145 |
| 2026-10-05 | Built: route, service, `OtpProvider` interface, `FakeOtpProvider`, startup refusal for `twofactor` (blocked on M0); `verify` returns true or false | send-otp code step |
