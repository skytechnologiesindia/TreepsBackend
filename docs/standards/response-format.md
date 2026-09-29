# Response Format

Status: Draft

Every reply from the API, success or error, uses exactly one of two shapes.

## 1. Success envelope
```json
{
  "success": true,
  "data": {},
  "requestId": "..."
}
```
- `data` holds the API's result. The shape of `data` is documented in each API doc.
- The handler's return value is wrapped as is. The wrapper never unwraps or reads it, so a handler that returns `{ "data": ..., "message": ... }` gets that whole object under `data`.
- A success with no result (`undefined`) returns `"data": null`. Every other value (object, array, string, number, boolean, null) goes into `data` unchanged.
- The wrapper never changes the HTTP status. It is Nest's default (200, or 201 for POST) unless the API doc sets another. 204 is not used; an API with nothing to return replies 200 with `data: null`.
- List results and pagination: where the page information goes is TO DECIDE.
- The success HTTP status (200, 201) is documented per API.

## 2. Error envelope
```json
{
  "success": false,
  "error": {
    "code": "INVALID_INPUT",
    "message": "Please check your input.",
    "field": "dropLat",
    "details": [
      { "field": "dropLat", "reason": "OUT_OF_RANGE" },
      { "field": "dropLng", "reason": "WRONG_TYPE" }
    ]
  },
  "requestId": "..."
}
```
- `code` is from the registry below.
- `message` is an English fallback and comes only from the registry.
- `field` is the name of the request field the error is about, exactly as the client sent it. It is `null` when the error is not about one input. When several fields are invalid, `field` is the first entry of `details` that is not `$unknown`, or null if there is none. Why: `field` lets the app highlight one input, and `$unknown` is not an input.
- `details` appears only on INVALID_INPUT. It lists the invalid fields as `{ field, reason }`, sorted A to Z by `field` (plain code-unit order), with at most 20 entries applied after sorting. The request is rejected either way. It is omitted on all other codes.
- `reason` is a fixed code from `input-validation.md` section 3 (for example WRONG_TYPE or UNKNOWN_FIELD). It is never library text.
- The name of an unknown field is echoed only if it matches `^[A-Za-z_][A-Za-z0-9_.]{0,63}$`. All other unknown names collapse into ONE entry `{ "field": "$unknown", "reason": "UNKNOWN_FIELD" }`, which sorts first in `details` because `$` comes before letters; `field` skips it.
- When the whole body is unusable (missing, empty, an array, `null` or a bare string), the reply is INVALID_INPUT with `field` null and `details` omitted, because there is no field to point at.

## 3. The one-shape rule
Every reply uses one of the two shapes above, including errors raised by the framework:

| Situation | Reply |
|---|---|
| Unknown route | NOT_FOUND, 404 |
| Missing or bad token | UNAUTHORIZED, 401 |
| Wrong role | FORBIDDEN, 403 |
| Malformed or invalid request body | INVALID_INPUT, 400 |
| Any other unmapped 4xx error (for example 405, 413) | INVALID_INPUT, 400, `field` null |
| Any unmapped 5xx error, any unexpected crash, any non-HTTP error | INTERNAL_ERROR, 500, generic message only |

- An unexpected crash never returns a stack trace, an internal message or any detail about the server.
- The real error is logged on the server. A 4xx reply is logged as a warning with the `requestId`, the code and the status, without a stack. A 5xx or non-HTTP error is logged as an error with the `requestId`, the error and its stack. The log never contains the request URL, method, body or headers, which can hold phone numbers and tokens.
- A non-Nest error counts as a 4xx only when its status is 400 to 499 and it has `expose === true` (as body-parser's errors do). Any other non-Nest error, such as an upstream provider's 4xx, stays INTERNAL_ERROR 500 and is logged with its stack.
- Unmapped errors: any 4xx `HttpException` without its own registry code becomes INVALID_INPUT, 400, with `field` null. Any unmapped 5xx and any non-HTTP error becomes INTERNAL_ERROR, 500, with the generic message only. Both cases are logged with the `requestId`. Why: a client mistake such as an oversized body should not look like a server failure.
- Dedicated codes for 405 and 413: TO DECIDE.

## 4. HTTP status per error type
| Error type | HTTP status |
|---|---|
| Invalid input | 400 |
| No or bad token | 401 |
| Wrong role, or an account state that blocks the action | 403 |
| Not found | 404 |
| Conflict | 409 |
| Valid request that breaks a business rule | 422 |
| Rate limit | 429 |
| Internal | 500 |

503 is not in the registry for now. A SERVICE_UNAVAILABLE row is added when a real case appears.

## 5. Error-code registry
Messages for the estimate codes are copied from `docs/api/estimate.md`, where they are proposed and not yet confirmed. Several codes share a status (for example FORBIDDEN, PAYMENT_DUE and ACCOUNT_BANNED are all 403), so apps tell them apart by `code`.

| Code | HTTP status | Rider-safe message (English fallback) | `field` |
|---|---|---|---|
| INVALID_INPUT | 400 | "Please check your input." | The first invalid request field (all are in `details`) |
| UNAUTHORIZED | 401 | "Please log in again." | null |
| FORBIDDEN | 403 | "You don't have access to this." | null |
| NOT_FOUND | 404 | "We couldn't find that." | null |
| CONFLICT | 409 | "This can't be done right now. Please refresh and try again." | null |
| RATE_LIMITED | 429 | "Too many requests. Try again shortly." | null |
| INTERNAL_ERROR | 500 | "Something went wrong. Please try again." | null |
| OUT_OF_SERVICE_AREA | 422 | "We don't serve this area yet." (proposed) | pickupLat or dropLat, whichever is outside |
| PICKUP_DROP_TOO_CLOSE | 422 | "Pickup and drop are too close." (proposed) | dropLat |
| TRIP_TOO_LONG | 422 | "This trip is too long for now." (proposed) | dropLat |
| ROUTE_UNAVAILABLE | 422 | "We couldn't plan this route. Try again." (proposed) | null |
| PAYMENT_DUE | 403 | "Please clear your pending payment first." (proposed) | null |
| ACCOUNT_BANNED | 403 | "This account can't book rides." (proposed) | null |

Where the registry lives in code: `src/common/errors/error-registry.ts`. Controllers throw a single `AppException` (`src/common/errors/app.exception.ts`) with a code and optional `{ field, details }`. Status and message come only from the registry; `details` is accepted only with INVALID_INPUT and the constructor rejects it on any other code.

## 6. Request id
- The server generates a `requestId` for every request. It is built in F3.2.
- Format: UUID v4, generated with Node's built-in `crypto.randomUUID`.
- A client-sent `X-Request-Id` is ignored and never trusted.
- It is returned in the body (`requestId`) and in the `X-Request-Id` response header.

## 7. Rules and why
1. **Every reply uses exactly one of the two shapes.** Why: the apps parse every reply with one code path and never need a special case.
2. **Every reply carries a server-generated `requestId`; a client-sent id is ignored.** Why: support can match a rider's report to the exact server log line, and nobody can forge log entries.
3. **Unexpected crashes return INTERNAL_ERROR with a generic message and no stack trace.** Why: stack traces and internal messages show attackers how the server works.
4. **An unmapped 4xx error becomes INVALID_INPUT; an unmapped 5xx or non-HTTP error becomes INTERNAL_ERROR.** Why: a client mistake such as an oversized body should not look like a server failure, and an unknown server failure must not leak details or invent a code.
5. **Codes are UPPER_SNAKE_CASE and are never renamed once an app ships.** Why: rider and driver apps in the field branch on the code text, so a rename breaks every installed version.
6. **The code is the contract; the message is an English fallback. Apps may show their own localized text keyed on the code.** Why: riders may read Hindi or English, and wording can change without breaking any app.
7. **Messages live only in the registry, never typed inside controllers.** Why: one place to review and keep them safe for riders, and the same error always reads the same.
8. **A new error means a new registry row first.** Why: keeps the registry complete, so the apps know every code they can receive; it also follows the docs-first rule.
9. **HTTP status comes from the registry, not chosen ad hoc.** Why: each status keeps one meaning across all APIs.
10. **`field` is the request field name as the client sent it, or null; `details` exists only on INVALID_INPUT.** Why: the app can highlight the exact inputs without parsing text, and every other error stays small and predictable.
11. **Messages never contain internal details or another user's data.** Why: replies reach the rider's phone and any network in between.
12. **Error logs never contain request URLs, methods, bodies or headers.** Why: they can hold phone numbers and tokens.
13. **The success wrapper always wraps what a handler returns and never unwraps or reads it.** Why: the shape of a reply must never depend on what a handler happens to return.
14. **No 204 responses; an API with nothing to return replies 200 with `data: null`.** Why: a 204 cannot carry a body, so the envelope would be lost.
15. **Controllers never use `@Res()`, and never return a `StreamableFile` or other raw stream, without the owner's approval.** Why: both bypass or break the envelope.

## Current code vs this format
F3.2 is done. The request id middleware, the error registry with `AppException`, the exception filter and the response interceptor are implemented and registered through `setupApp`. The HTTP contract tests are in `src/common/contract.http.spec.ts`.

## Changelog
| Date | What changed | Why |
|---|---|---|
| 2026-09-29 | Draft created | F3.2 docs-first |
| 2026-09-29 | Settled request id format, registry location, unmapped-error rule and log content | F3.2 decisions before code |
| 2026-09-29 | Added the expose rule for non-Nest 4xx errors and the log levels | Exception filter built (piece c) |
| 2026-09-29 | Success wrapper rules (always wrap, no 204, no `@Res()`) and current-code section updated | Response interceptor rewritten (piece d) |
| 2026-09-29 | Current-code section updated: F3.2 done, contract tests added | HTTP contract tests (piece e) |
| 2026-09-29 | Resolved `details.reason` (fixed codes), A to Z order, the 20 cap and the `$unknown` entry | F3.3 input validation standard |
| 2026-09-29 | `field` skips the `$unknown` entry; an unusable body has `field` null and no `details` | Owner decisions before commit |
