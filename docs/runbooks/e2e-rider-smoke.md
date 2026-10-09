# Rider flow smoke test (real Postgres, real HTTP)

One command: `npm run e2e:rider`. It is not part of `npm test` or `npm run test:e2e`; it has its own config (`vitest.config.e2e-rider.ts`) and only runs when `RUN_E2E_PG=1`, which that config sets.

## What it does
1. Creates the scratch database `treeps_scratch_e2e` on the server named in `DATABASE_URL` (only host, port, user and password are used; the database name is a constant in the spec, never `treeps_db`). An old copy is dropped first.
2. Applies the real migrations with `prisma migrate deploy`.
3. Boots the real `AppModule` with the production wiring (`setupApp`, `assertRouteInputs`) on a random port with `OTP_PROVIDER=fake`, `ALLOW_FAKE_OTP=true`, `FAKE_OTP_CODE=424242` and no token secret (sessions need none). The scratch `DATABASE_URL` is set in the process, so `.env` cannot override it.
4. Runs 35 cases (1 to 25 rider and driver login, validation, conflicts, bans and limits; 26 to 34 sessions: sliding expiry, ban, logout, one active driver session, rider per device, hashed storage; 35 the envelope) over real `fetch`, prints a table (case, expected, actual, PASS/FAIL), then drops the scratch database and checks it is gone. The run fails if any case fails.

## Notes
- A fresh app is started for each case group, so the in-memory IP rate counters start empty (the register limit is 10 an hour per IP).
- Each case uses a fresh phone number. The per-phone 30 s resend cooldown is counted from `OtpSession.createdAt` in the database, so where a case needs a second OTP for the same phone (8, 9, 21, 25) the test moves that phone's session rows 31 s into the past with an `UPDATE` on the scratch database instead of sleeping. Case 22 uses the real cooldown.
- Cases 7, 12, 21, 26 and 27 also write to the scratch database directly (`isEmailVerified = true`, `status = 'SUSPENDED'`) to set up their starting state.
- Case 17 and 18 expect HTTP 400 with `error.code` `INVALID_INPUT` and `details` reason `UNKNOWN_FIELD` (that is how the API reports an unknown field).

## Found by this test
2026-10-09: the first run failed cases 8, 9, 21 and 25. Cause: the dev Postgres runs in `Asia/Calcutta`, and a `Date` parameter compared with a `timestamptz` column was read in the server's local time, so every `createdAt > now - X` query was off by 5 h 30 min (the 30 s resend cooldown behaved like 5.5 hours). Fixed by opening every connection in UTC (`src/prisma/prisma.service.ts`). See decision 169.

## Session cases (26 to 34, 2026-10-09)
Real-Postgres cases for the server-side sessions (decisions 174 to 178). They move rows in time with `UPDATE` on the scratch database where a case needs an expired session (12) or a session last used two hours ago (26), instead of sleeping.
