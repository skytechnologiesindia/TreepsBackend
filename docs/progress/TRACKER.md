# Progress Tracker

Last updated: 2026-10-05

| Stage | What | Status |
|---|---|---|
| F1 | Safety net: .gitignore, first commit, project rename | Done |
| F2 | Prisma 7 config fixed, dev DB emptied after backup, init migration applied | Done |
| F3 | Foundations | In progress |
| F3.0 | Documentation foundation | Done |
| F3.1 | Repo hygiene | Done |
| F3.2 | Response envelope, error-code registry and request id | Done |
| F3.3 | Input and config validation | Done |
| F3.4 | /v1 versioning only | Done |
| F4 | Auth: real JWT, role guard, remove mock token | Not started |
| F5 | Rider, driver, ride and quote models | Not started |
| L0 | First estimate API, `POST /v1/rides/estimate`, with FAKE fixed fares | Done (commit dba5201) |
| F4-R | Rider register (send-otp + register) with 2Factor | Docs drafted, awaiting owner approval |

## Rider register (F4)
Docs: `api/rider-send-otp.md`, `rider-verify-otp.md`, `rider-register.md`, `rider-refresh.md`, `rider-logout.md` (all APPROVED 2026-10-05; items still marked TO DECIDE inside them stay open). Coach mode: the owner types the code. Decisions 84 to 145.
- [x] Step 1: read-only discovery
- [x] Step 2: docs drafted (two API docs, decisions 84 to 99, five error-code rows in `response-format.md`)
- [x] Step 3: final Rider data model recorded in `api/rider-register.md` (decisions 100 to 108); `rider-send-otp.md` made unified (purpose `RIDER_AUTH`)
- [x] Step 4: unified flow written (five route docs, decisions 109 to 119); register-before-admin-auth exception recorded (decision 119)
- [x] Owner decides what happens to a DELETED rider's phone: plain unique (decision 128)
- [x] Owner approves the five docs and every PROPOSED value (decision 129)
- [ ] 2Factor request format, session-id field, verify behavior and OTP length: confirmed in M0 (decision 127; not guessed in the docs). Blocks only the real 2Factor client (the owner's M4, decision 145); the fake provider and everything else are not blocked
- [x] Decided 2026-10-05: fake provider gate, verify 10 per phone per hour, refresh and logout 30 per IP per hour, `TRUST_PROXY_HOPS`, sliding refresh, no grace window, public logout, DELETED plain unique (decisions 120 to 128)
- [x] Decided 2026-10-05 (second round): 503, gender values, device field rules, HS256 JWT, no audit table, fullName and email rules, refresh and logout 120 per IP per hour, DELETED confirmed, final config keys (decisions 130 to 139)
- [x] Owner approved the shared-type rules in `input-validation.md` section 2b (decisions 140, 145); `fullName` allows `-` but not first, last or doubled (141); email (142); `appVersion` regex (143)
- [x] Non-blocking open items settled with the docs' defaults (decision 144)
- [ ] Still open, none blocks the code: DLT registration for India SMS (owner action, needed before real SMS), the admin endpoints and the pagination shape (deferred, decision 119), the production migration process (`runbooks/database.md`)
- [ ] Owner answers: DLT registration for India SMS
- [x] Documented in `input-validation.md`: section 2b (new shared types: IndianMobile, Email, PersonName, OtpCode, OpaqueToken, DeviceId, AppVersion, fcmToken limits) and section 6 (six startup keys). The date-only type is still not needed until a date-of-birth field is built
- [x] Built: `IndianMobile` in `src/common/validation/fields.ts` (spec in `fields.spec.ts`)
- [x] Built: `OtpCode`, `DeviceId`, `AppVersion` (specs in `fields.spec.ts`)
- [ ] Still to build: `Email`, `PersonName`, `OpaqueToken`
- [ ] Error registry: type the six rows (OTP_INVALID, OTP_EXPIRED, OTP_ATTEMPTS_EXCEEDED, OTP_PROVIDER_ERROR, REGISTRATION_TOKEN_INVALID, EMAIL_IN_USE) into `src/common/errors/error-registry.ts`, and update `error-registry.spec.ts` (13 becomes 19 codes; 503 added to the allowed statuses, decision 130)
- [x] Prisma models typed (`prisma/models/rider.prisma`, `rider-auth.prisma`), `prisma validate` and `format` clean, migration `20261005101140_rider_auth_data_model` created with `--create-only` and hand-edited (safe name change); dev DB checked first (localhost `treeps_db`, 0 rows)
- [x] Migration tested on a scratch database (2 fake old-format riders: names merged, dates and gender kept, schema diff empty), `treeps_db` backed up (`C:\Users\HP\Documents\treeps_db-backup-2026-10-05.dump`), migration applied to `treeps_db` with `prisma migrate deploy`, `prisma generate` run (2026-10-05)
- [x] Config (done, `src/config/env.validation.ts`, `.env.example`, specs updated): `OTP_PROVIDER` (twofactor or fake, required), `ALLOW_FAKE_OTP` (must be `true` with fake), `FAKE_OTP_CODE` (6 digits, required with fake), `TWOFACTOR_API_KEY` (required with twofactor), `TRUST_PROXY_HOPS` (0 to 10, default 0), `JWT_ACCESS_SECRET` (32 characters or more, required); each gets a validation rule in `src/config/env.validation.ts` and a line in `.env.example` in the same commit; the app refuses to start with the fake provider in production
- [x] `OtpProvider` interface, `FakeOtpProvider`, provider chosen by `OTP_PROVIDER`; `twofactor` refuses to start with "twofactor client not built yet (blocked on M0)" (decision 148)
- [ ] Real 2Factor client (5 s timeout, no retry) and its tests: blocked on M0
- [x] In-memory rate-limit guard built, hand-written with no dependency (`src/common/rate-limit/`, numbers in `src/config/rate-limits.ts`, decision 147); it is NOT attached to any route yet
- [ ] Attach `@RateLimit` to each rider auth route when it is built (numbers: `RATE_LIMITS`); done for send-otp
- [ ] Retry-After header on RATE_LIMITED: TO DECIDE (none is sent today)
- [x] `send-otp` code and tests (shared `src/modules/otp/`, rider route in `src/modules/rider-auth/`, decisions 148 and 150)
- [x] Driver `send-otp` (`src/modules/driver-auth/`, `docs/api/driver-send-otp.md`, `DRIVER_AUTH` migration applied, shared code in `src/modules/otp/`, decision 150)
- [x] Driver `verify-otp` (`src/modules/driver-auth/`, `api/driver-verify-otp.md` written with the build, decisions 152 to 159): `Driver`, `DriverDevice`, `DriverRefreshToken` models and migration `20261007120000_driver_auth_data_model` applied (backup `C:\Users\HP\Documents\treeps_db-backup-2026-10-07.dump`); shared code check `OtpCodeChecker` also used by rider verify-otp; role `DRIVER`; race test on real Postgres (`driver-verify-otp.pg.spec.ts`, scratch database `treeps_scratch_driver`, `RUN_PG_TESTS=1`); waiting for the owner to commit
- [x] Driver `register`: not needed, driver verify-otp creates the account (decision 156)
- [ ] Driver admin visibility (audit, tracking, metrics endpoints): TO DECIDE whether decision 119 (rider auth before admin auth) also covers drivers
- [ ] Driver audit log lines (`driver.created`, `driver.login.succeeded`, `driver.login.banned`): need a request context (same item as the rider lines)
- [ ] Driver `refresh` and `logout`: need their own docs and owner approval first
- [ ] The JWT guard (F4) must check the access token's `role` (RIDER or DRIVER) against the route's domain; today only the claim differs (decision 158)
- [ ] Driver status rules after login (what DOCUMENTS_PENDING, UNDER_REVIEW, REJECTED may do; whether REJECTED may log in): TO DECIDE
- [x] Driver `send-otp` (`src/modules/driver-auth/`, `api/driver-send-otp.md`, decision 150): `DRIVER_AUTH` migration applied (backup `C:\Users\HP\Documents\treeps_db-backup-2026-10-06.dump`)
- [ ] Owner approves `api/driver-send-otp.md` and `api/driver-verify-otp.md` (both built first on instruction)
- [x] `verify-otp` code and tests (`src/modules/rider-auth/`, decision 149)
- [x] `verify-otp` new-phone fix: marking the code used and storing the registration token hash are one conditional write, so a failure cannot burn the code without a token (2026-10-06; test injects the failure). Login path (ACTIVE rider) still marks the code used before its transaction: combining them is TO DECIDE
- [ ] Audit log lines (`login.succeeded`, `otp.locked`, `login.banned`, `registration_token.issued`, ...): need a request context so a service can log the `requestId`
- [ ] `register` code and tests (including the race tests)
- [ ] `refresh` code and tests (rotation, reuse detection)
- [ ] `logout` code and tests
- [x] Access token signing: hand-written HS256, claims iss, sub, role, deviceId (decisions 133, 149)
- [ ] The JWT guard and the authenticated-user decorator for later APIs (F4); `verifyHs256Jwt` is ready for it
- [x] Removed the Firebase auth code (`src/auth/`), its module registration and tests, and both "remove in F4" allowlist entries (decision 146)
- [ ] Final cleanup: remove `firebase-admin` from `package.json`
- [ ] Docs and changelog updated; owner says when to commit

Admin visibility (CLAUDE.md): `GET /v1/admin/riders`, `GET /v1/admin/riders/:id`, `GET /v1/admin/metrics/riders` (proposed in `api/rider-register.md`). **Exception proposed in decision 119: the rider auth routes ship before admin auth.** The admin endpoints wait for admin authentication (no admin model or guard exists) and for the pagination shape (TO DECIDE).

## L0 checklist
The owner typed the code. Step 1 was a read-only orientation.
- [x] Step 2: L0 section written in `api/estimate.md`
- [x] Step 3: request DTO (`src/modules/rides/dto/estimate.dto.ts`)
- [x] Step 4: service returning the FAKE values
- [x] Step 5: controller (`@HttpCode(200)`), module, import in `app.module.ts`
- [x] Step 6: tests (`src/modules/rides/rides.http.spec.ts`)
- [x] Step 7: `api/estimate.md` and this tracker updated

## F3.2 checklist
- [x] Docs settled (`standards/response-format.md`, `decisions/DECISIONS.md`)
- [x] a. Request id (middleware and `setupApp` helper)
- [x] b. Error registry and `AppException`
- [x] c. Exception filter
- [x] d. Response interceptor rewrite
- [x] e. Integrated HTTP tests, then mark F3.2 done

## F4 notes
- Login is the 2Factor phone OTP flow (decision 84), which supersedes the Firebase login of decision 77. The Firebase code was removed on 2026-10-05.

## F3.4 checklist
- [x] Versioning in `setupApp` (`api-version.ts`), test helper `testing/base-url.ts`, specs on the versioned base URL, new `api-version.http.spec.ts`
- [x] Banned-patterns rule: no version written in a `@Controller` path
- [x] E2E: `/v1` served, `/`, `/v2/x` and `/auth/login` are NOT_FOUND, `/v1/auth/login` is served
- [x] Docs: `api-standard.md` section 8, `response-format.md`, decisions 72 to 76
- [x] Request-flow guide (`docs/learning/how-a-request-flows.md`)

## F3.3 checklist
- [x] a. Docs (`standards/input-validation.md`, decisions, response-format)
- [x] b. INVALID_INPUT wording "Please check your input." (registry, `response-format.md`, `estimate.md`)
- [x] c. Building blocks: reason codes, shared field types, pipe error conversion
- [x] d1. `InputValidationPipe`, `setupApp` registration, HTTP validation tests, banned-patterns test, deliberate contract-test change
- [x] d2. Startup route input check (`route-inputs.ts`), `main.ts`, real-routes test, DTO initializer check
- [x] e. Config validation (DATABASE_URL, PORT, NODE_ENV) and startup database check
- [x] f. e2e import fix, then the e2e boots the real wiring (`test/app.e2e-spec.ts`, `vitest.config.e2e.ts`)

Piece notes:
- Piece d:
  - verify decorator metadata is emitted under Vitest, and add a canary test proving a DTO route rejects bad input;
  - a route typed with an inline type or interface has no class for the pipe, so plan a fail-closed rule;
  - rule 11 subclass: a `ValidationPipe` subclass that treats a missing, `null`, array, or bare string, number or boolean body as unusable (Nest turns `null` and a missing body into `{}` before validating, so the converter alone cannot do it).
- Piece e: the owner adds `NODE_ENV=development` to the local `.env` before it runs; the agent never edits `.env`. `.env.example` gets the same line in the same commit.
- Tests to write (piece c or d):
  - a missing required field gives REQUIRED;
  - `null` on an optional field is WRONG_TYPE;
  - a nested unknown field (`pickup.foo`) is rejected;
  - odd bodies (none, `null`, `[]`, bare string, number, boolean) give INVALID_INPUT with `field` null and no `details`, and never crash; an empty object `{}` is validated by the DTO;
  - an unknown query parameter is rejected;
  - the banned-patterns scan (piece d);
  - class-validator text never appears in a reply;
  - only `$unknown` invalid gives `field` null, with `details` containing the `$unknown` entry;
  - `$unknown` plus a real bad field gives `field` = the real field.
- The contract test that pinned `field` null for pipe errors was changed on purpose in piece d1 (the route now uses a DTO, and the test asserts `field` `'id'` and `details`).

## Backlog
- `Rider` has no account status field (F5).
- Rename branch `master` to `main` before the first push.
- Keep the DB backup until F4 is done (see `runbooks/database.md`).
- Resolve the TO DECIDE items in `api/estimate.md` and `engines/fare-engine.md` before any fare math is built.
- Add a modifiers list and a discount line to the estimate breakdown (open question in `engines/fare-engine.md`).
- When code reads a new env variable, `.env.example` changes in the same commit.
- The `.claude` and `.windsurf` skill symlinks use absolute paths and break when the project folder is renamed. Reinstall the skills afterwards.
- Project folder is still `XCabServer` on disk (rename: optional, not decided).
- Confirm the six estimate error messages (OUT_OF_SERVICE_AREA, PICKUP_DROP_TOO_CLOSE, TRIP_TOO_LONG, ROUTE_UNAVAILABLE, PAYMENT_DUE, ACCOUNT_BANNED) before the estimate API ships.
- Access log (method, route, status, duration per request) is not built; the exception filter deliberately does not log URLs or methods. Decide what an access log may contain.
- Decide dedicated codes for 405 and 413; the warning log records `originalStatus` so real cases can be seen.
- Keep server logs access-controlled: Prisma error text can contain input values.
- Guards registered through `APP_GUARD` in F4 will not be in `setupApp`; the test modules must import the same guard setup, or the tests will not prove what production does.
- If a browser admin panel is ever built, it needs `Access-Control-Expose-Headers: X-Request-Id`.
- Extract a shared HTTP test helper (app setup, base URL, UUID regex) with no assertion changes and its own commit, after F3.3.
- Security headers (for example `X-Content-Type-Options: nosniff`) must be added before deployment.
- `PrismaService` should use the validated config instead of reading `process.env` directly (F4 or F5).
- Restrict request bodies to `application/json` before F5 (Nest also accepts `application/x-www-form-urlencoded`, which turns `b[c]=2` into a nested object).
- The DTO initializer check (d2) covers top-level route DTOs only, not nested DTO classes.
- The route input check (d2) does not cover file uploads or dynamically added routes.
- Warn or refuse if `NODE_ENV=test` is used outside a test runner.
- Startup check that migrations are applied (the database check only proves the database answers).
- Decide a safe way to log real startup errors for operators before deployment. Today only our three own error types (env, database check, route inputs) print their message; any library error prints only a generic line (decision 68).
- Decide whether `npm test` should also run the e2e spec when the first real e2e for a real API exists (today `.e2e-spec.ts` runs only through `npm run test:e2e`).
- Rate limiting: none exists although RATE_LIMITED is in the registry; build with F4 (needs the user id), before the estimate API.
- Build `/health` as `VERSION_NEUTRAL` (no database call, never changes) before deployment.
- Banned-patterns scan is line-based: a `@Controller(` whose path string is on the next line slips past the "no version in a controller path" rule (see `api-standard.md`, section 8). Fix only if it ever appears.
- Rider register: access tokens stay valid for up to 15 minutes after a logout, ban or token revocation (stateless JWT); the deferred `tokenVersion` column would close that gap.
- Rider register: `SavedPlace` and `EmergencyContact` have no index on `riderId` (existing gap, reported only).
- Confirm the error messages of the six rider-auth codes (OTP_INVALID, OTP_EXPIRED, OTP_ATTEMPTS_EXCEEDED, OTP_PROVIDER_ERROR, REGISTRATION_TOKEN_INVALID, EMAIL_IN_USE) and the ACCOUNT_BANNED wording for login; they are still marked "(proposed)" in `response-format.md`.
- "M0" and "M4" are the owner's milestone names (M0 confirms the 2Factor request format, M4 needs the real 2Factor client); the milestone list is not written in the repo docs yet.
- Do not deploy before F4: the L0 estimate route has no login (decision 81). The old Firebase mock-token hole is gone with the code.
