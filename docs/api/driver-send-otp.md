# POST /v1/driver/auth/send-otp

Status: Draft, built on the owner's instruction of 2026-10-06 ("add DRIVER send-otp, reusing the rider logic"). Every rule that is not stated here is the rule of `rider-send-otp.md`, which is APPROVED. Items marked TO DECIDE have no decision yet.

The driver verify-otp route is built and documented in `driver-verify-otp.md` (2026-10-07; it also creates the account, so there is no separate driver register route). This route only sends the code.

The path `/v1/driver/auth/send-otp` is as instructed; the controller writes `@Controller('driver/auth')` and never `v1`.

## Purpose
A person who wants to log in or register as a driver asks for a code to prove they own a phone number. Exactly as `rider-send-otp.md`: it asks the SMS provider to send a 6-digit code, stores the provider session on the server, never reads any account table, gives the same reply for every phone, creates no account and issues no token.

## Who calls it
Driver app, at the start of login or registration. Public endpoint (an explicit exception to the "valid token required" gate in `api-standard.md` section 1). Gate checks: rate limit and validation only.

## What is the same as the rider route
Everything in `rider-send-otp.md`, by reference: the request body, the validation (`IndianMobile`, unknown fields rejected), the reply, the order of checks, the OTP provider and its startup rules, the error table, the in-memory IP rate limit and its `TRUST_PROXY_HOPS` rule, logging, and the required tests. The shared code is `SendOtpService` in `src/modules/otp/`; the rider and driver controllers each call it with their own purpose.

## What is different
| Point | Rider | Driver |
|---|---|---|
| Path | `/v1/rider/auth/send-otp` | `/v1/driver/auth/send-otp` |
| OTP purpose stored on the `OtpSession` | `RIDER_AUTH` | `DRIVER_AUTH` |
| IP rate-limit counters | name `send-otp` | name `driver-send-otp` (its own counters; same numbers) |
| Module | `RiderAuthModule` | `DriverAuthModule` |

## Request fields
Body, JSON. Only the field below is accepted; unknown fields (including `purpose`, `otp`, `role`) are rejected with `UNKNOWN_FIELD`.

| Name | Type | Unit | Required? | Allowed range | Why it exists | Why this type/unit | Bucket | What breaks if wrong |
|---|---|---|---|---|---|---|---|---|
| phoneNumber | string | E.164 text | Required | `+91` followed by 10 digits, first of the 10 in 6 to 9 (`IndianMobile`). Nothing is trimmed or normalized. | Identifies who is logging in or registering and where the SMS goes | One canonical spelling per number | Identity | A malformed number wastes a paid SMS |

**The purpose is never read from the request.** It is fixed by the route. A client-sent `purpose` is an unknown field and is rejected, so a driver code can never be requested through the rider route or the other way round.

## Response fields
Success: HTTP 200. `data` is `{ expiresInSeconds: 300, resendAfterSeconds: 30 }`, identical for every phone. The provider session id and the code are never returned.

## Order of checks
As in `rider-send-otp.md`: IP rate limit, body validation, then the per-phone limits from `OtpSession` rows, then the provider call, then the row is stored, then the reply. **The per-phone counts are per phone and per purpose**:
- the 30 second resend cooldown looks only at sessions with purpose `DRIVER_AUTH` for that phone;
- the 5 sends per hour per phone counts only sessions with purpose `DRIVER_AUTH` for that phone.
A rider OTP session for the same phone does not count toward the driver limits, and a driver session does not count toward the rider limits. The same phone number may therefore ask for a rider code and a driver code at the same time.

## Data stored
One `OtpSession` row with `purpose` = `DRIVER_AUTH` (the `OtpPurpose` enum gained this value in migration `20261006105503_add_driver_auth_otp_purpose`). The other columns are as in `rider-send-otp.md`.

## Rate limit
20 requests per IP per hour (`RATE_LIMITS.sendOtp.ip`), counted separately from the rider route. Per phone and per purpose: 5 sends per hour and a 30 second cooldown, counted from `OtpSession` rows. Whether a rider and a driver on one shared IP should share one IP counter: TO DECIDE (today they do not).

## Errors
The same table as `rider-send-otp.md`: `INVALID_INPUT` (400), `RATE_LIMITED` (429), `OTP_PROVIDER_ERROR` (503), `INTERNAL_ERROR` (500).

## Edge cases and known limitations
- The rider verify-otp route reads only sessions with purpose `RIDER_AUTH`, so a driver code cannot log a rider in. The driver verify-otp route does the same with `DRIVER_AUTH` (`driver-verify-otp.md`), through the same shared code check.
- A phone number that belongs to both a rider and a driver is allowed here; whether one person may hold both accounts: TO DECIDE.
- SMS cost, DLT registration and the 2Factor client: as in `rider-send-otp.md` (blocked on M0).

## Required tests
- Happy path: 200, the two numbers, one `OtpSession` with purpose `DRIVER_AUTH`, no session id in the reply.
- Same reply for any phone; no account table is read.
- Invalid phone cases and unknown fields (`purpose`, `otp`) give `INVALID_INPUT`.
- Cooldown: a second send inside 30 seconds is `RATE_LIMITED`, with no provider call and no new row.
- Hourly limit: the 6th send in an hour for one phone is `RATE_LIMITED`; allowed again after the hour.
- IP limit: the 21st request from one IP in an hour is `RATE_LIMITED`.
- Provider failure: `OTP_PROVIDER_ERROR` (503), nothing stored, one call.
- **Isolation:** a rider session for the same phone does not trigger the driver cooldown or the driver hourly limit, and five rider sessions do not use up the driver's five sends (and the same the other way round).
- The route is not served without `/v1`.

## Changelog
| Date | What changed | Why |
|---|---|---|
| 2026-10-06 | Draft created and built: driver send-otp, purpose `DRIVER_AUTH`, per phone and per purpose limits | Owner instruction of 2026-10-06 |
| 2026-10-07 | Notes updated: driver verify-otp is built (`driver-verify-otp.md`); no behavior change here | Driver verify-otp (decision 155) |
