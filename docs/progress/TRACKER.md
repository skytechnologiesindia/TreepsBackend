# Progress Tracker

Last updated: 2026-09-30

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

## F3.2 checklist
- [x] Docs settled (`standards/response-format.md`, `decisions/DECISIONS.md`)
- [x] a. Request id (middleware and `setupApp` helper)
- [x] b. Error registry and `AppException`
- [x] c. Exception filter
- [x] d. Response interceptor rewrite
- [x] e. Integrated HTTP tests, then mark F3.2 done

## F4 notes
- Login uses Firebase phone authentication: the server verifies Firebase ID tokens (decision 77).

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
- Login code uses the removed `prisma.user` (`src/auth/auth.service.ts`). Fix in F4; do not patch before.
- Mock token security hole in `src/auth/firebase.service.ts`. **Do not deploy before F4.**
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
- `POST /auth/login` reads `@Body('idToken')` and stays unvalidated (unknown body fields not rejected) until F4; its file is on the banned-patterns allowlist until then.
- Restrict request bodies to `application/json` before F5 (Nest also accepts `application/x-www-form-urlencoded`, which turns `b[c]=2` into a nested object).
- The DTO initializer check (d2) covers top-level route DTOs only, not nested DTO classes.
- The route input check (d2) does not cover file uploads or dynamically added routes.
- Remove both auth allowlist entries in F4: the banned-patterns allowlist and `ROUTE_INPUT_ALLOWLIST` (search for `remove in F4`).
- Warn or refuse if `NODE_ENV=test` is used outside a test runner.
- Startup check that migrations are applied (the database check only proves the database answers).
- Decide a safe way to log real startup errors for operators before deployment. Today only our three own error types (env, database check, route inputs) print their message; any library error prints only a generic line (decision 68).
- Decide whether `npm test` should also run the e2e spec when the first real e2e for a real API exists (today `.e2e-spec.ts` runs only through `npm run test:e2e`).
- Rate limiting: none exists although RATE_LIMITED is in the registry; build with F4 (needs the user id), before the estimate API.
- Build `/health` as `VERSION_NEUTRAL` (no database call, never changes) before deployment.
- Banned-patterns scan is line-based: a `@Controller(` whose path string is on the next line slips past the "no version in a controller path" rule (see `api-standard.md`, section 8). Fix only if it ever appears.
