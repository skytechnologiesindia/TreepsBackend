# Progress Tracker

Last updated: 2026-09-29

| Stage | What | Status |
|---|---|---|
| F1 | Safety net: .gitignore, first commit, project rename | Done |
| F2 | Prisma 7 config fixed, dev DB emptied after backup, init migration applied | Done |
| F3 | Foundations | In progress |
| F3.0 | Documentation foundation | Done |
| F3.1 | Repo hygiene | Done |
| F3.2 | Response envelope, error-code registry and request id | Done |
| F3.3 | Input and config validation | In progress |
| F3.4 | /v1 versioning only | Not started |
| F4 | Auth: real JWT, role guard, remove mock token | Not started |
| F5 | Rider, driver, ride and quote models | Not started |

## F3.2 checklist
- [x] Docs settled (`standards/response-format.md`, `decisions/DECISIONS.md`)
- [x] a. Request id (middleware and `setupApp` helper)
- [x] b. Error registry and `AppException`
- [x] c. Exception filter
- [x] d. Response interceptor rewrite
- [x] e. Integrated HTTP tests, then mark F3.2 done

## F3.3 checklist
- [x] a. Docs (`standards/input-validation.md`, decisions, response-format)
- [ ] b. INVALID_INPUT wording "Please check your input." (registry, `response-format.md`, `estimate.md`)
- [ ] c. Building blocks: reason codes, shared field types, pipe error conversion
- [ ] d. ValidationPipe wiring, contract test change, HTTP validation tests, banned-patterns test
- [ ] e. Config validation (DATABASE_URL, PORT, NODE_ENV)
- [ ] f. e2e import fix (`test/app.e2e-spec.ts` only)

Piece notes:
- Piece e: the owner adds `NODE_ENV=development` to the local `.env` before it runs; the agent never edits `.env`. `.env.example` gets the same line in the same commit.
- Tests to write (piece c or d):
  - a missing required field gives REQUIRED;
  - `null` on an optional field is WRONG_TYPE;
  - a nested unknown field (`pickup.foo`) is rejected;
  - odd bodies (none, empty, `[]`, `null`, bare string) give INVALID_INPUT and never crash;
  - an unknown query parameter is rejected;
  - the banned-patterns scan (piece d);
  - class-validator text never appears in a reply;
  - only `$unknown` invalid gives `field` null, with `details` containing the `$unknown` entry;
  - `$unknown` plus a real bad field gives `field` = the real field.
- The contract test that pins `field` null for pipe errors changes on purpose in piece d.

## Backlog
- E2E test cannot find `supertest/types` (`test/app.e2e-spec.ts`). Fix in F3.3.
- Login code uses the removed `prisma.user` (`src/auth/auth.service.ts`). Fix in F4; do not patch before.
- Mock token security hole in `src/auth/firebase.service.ts`. **Do not deploy before F4.**
- Open decision for F4: Firebase phone OTP or own OTP with an SMS provider. Must be decided before F4 starts.
- `Rider` has no account status field (F5).
- Rename branch `master` to `main` before the first push.
- Keep the DB backup until F4 is done (see `runbooks/database.md`).
- Resolve the TO DECIDE items in `api/estimate.md` and `engines/fare-engine.md` before any fare math is built.
- Add a modifiers list and a discount line to the estimate breakdown (open question in `engines/fare-engine.md`).
- F3.3 config validation must check `DATABASE_URL` and `PORT` at startup.
- When code reads a new env variable, `.env.example` changes in the same commit.
- The `.claude` and `.windsurf` skill symlinks use absolute paths and break when the project folder is renamed. Reinstall the skills afterwards.
- Project folder is still `XCabServer` on disk (rename: optional, not decided).
- INVALID_INPUT message says "this field" even when `field` is null; revisit wording in F3.3.
- Confirm the six estimate error messages (OUT_OF_SERVICE_AREA, PICKUP_DROP_TOO_CLOSE, TRIP_TOO_LONG, ROUTE_UNAVAILABLE, PAYMENT_DUE, ACCOUNT_BANNED) before the estimate API ships.
- Access log (method, route, status, duration per request) is not built; the exception filter deliberately does not log URLs or methods. Decide what an access log may contain.
- Decide dedicated codes for 405 and 413; the warning log records `originalStatus` so real cases can be seen.
- Keep server logs access-controlled: Prisma error text can contain input values.
- Guards registered through `APP_GUARD` in F4 will not be in `setupApp`; the test modules must import the same guard setup, or the tests will not prove what production does.
- Pipe errors carry `field` null today (pinned by the contract test in `src/common/contract.http.spec.ts`); F3.3 decides, and that test changes on purpose.
- If a browser admin panel is ever built, it needs `Access-Control-Expose-Headers: X-Request-Id`.
- Extract a shared HTTP test helper (app setup, base URL, UUID regex) with no assertion changes and its own commit, after F3.3.
- Security headers (for example `X-Content-Type-Options: nosniff`) must be added before deployment.
- `PrismaService` should use the validated config instead of reading `process.env` directly (F4 or F5).
- `POST /auth/login` reads `@Body('idToken')` and stays unvalidated (unknown body fields not rejected) until F4; its file is on the banned-patterns allowlist until then.
