# API Standard

Every API follows this. Exceptions must be recorded in `DECISIONS.md`.

## 1. Gate (runs before any logic)
- **Auth:** valid token required, except explicitly public endpoints.
- **Role:** the endpoint declares which roles may call it; enforced by a guard.
- **Ownership:** a caller may only touch their own records. The user id comes from the token, never from the request body.
- **Account status:** blocked/banned accounts are rejected with a specific error code.
- **Rate limit:** every endpoint has one. Values: TO DECIDE.
- **Validation:** see Input rules below.

### Input rules
- Each API declares its own allowed fields. Unknown fields are rejected.
- The client never sends derived values (price, distance, ETA, status, earnings).
- The shared field types (lat, lng, phone, money, date, uuid, page, pageSize, text), their exact rules, the reason codes and the startup configuration rules are in `input-validation.md`. That doc is the single source of truth; do not copy its rules here.

## 2. Logic
- The server computes all derived values.
- Status changes follow a documented state machine; illegal transitions are rejected.
- Endpoints that create or charge are idempotent (a repeated call must not duplicate the effect).
- Updates that can race are atomic (single transaction or conditional update).
- Values that later affect money or disputes are snapshotted at the time (for example fare rules version on a quote).
- Tunable values (rates, limits, thresholds) come from config or DB reference data, never hardcoded.

## 3. External calls (maps, payments, SMS)
- Every call has a timeout. Values: TO DECIDE.
- Every call has a defined fallback or a clear error code.
- Cache where the provider is paid or slow. Cache rules: TO DECIDE.

## 4. Response
- Success and error responses use the shared envelope (built in F3.2).
- Errors carry a `code` from the shared error-code registry, a rider-safe `message` and a `field`.
- Status codes: one meaning each, documented per API.
- No internal fields (database ids not meant for clients, stack traces, config values) in responses.

## 5. Data
- Add indexes for every field used in lookups and filters.
- List endpoints are paginated.

## 6. Ops
- Log every request with a request id (built in F3.2).
- Audit events are recorded for security-relevant and money-relevant actions.
- Never log secrets or full tokens.

## 7. Done means
- The API doc exists (from the template) and is approved BEFORE code is written.
- Tests listed in the doc pass.
- Docs and changelog are updated for any change.

## 8. Versioning
- Every route is served under a version prefix: `/v1/...`. `setupApp` applies it (`src/common/api-version.ts`), so production and every test share it.
- Versions are whole numbers only (`v1`, `v2`). A minor change to a version goes in that API's changelog, not in the path.
- **Controllers never write the version in their path.** Write `@Controller('rides')`, not `@Controller('v1/rides')`. Why: the default version already adds the prefix, so a written version would be served at `/v1/v1/rides`. A test in the banned-patterns scan enforces this. **Known limitation:** the scan reads line by line, so a `@Controller(` whose path string is on the next line is not caught. The review of a new controller must check it by eye.
- A route that must exist in another version uses `@Version('2')`; it is then served under `/v2` and not under `/v1`.
- Version-neutral routes (`VERSION_NEUTRAL`, no prefix) are reserved for `/health`, which must never change. Any other neutral route needs an entry in `DECISIONS.md`.
- A path with no version (`/rides`) or an unknown version (`/v2/rides` when nothing is v2) is the normal `NOT_FOUND` envelope. There is no special "unsupported version" error.
- `/V1` also works, because Express matches paths without regard to case. This is left as is.
