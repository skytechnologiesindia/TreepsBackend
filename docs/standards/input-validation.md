# Input Validation

Status: Draft

Every value a client sends is checked before any handler runs. A failed check replies with INVALID_INPUT (see `response-format.md`).

## 1. Rules
1. **Every API declares its own allowed fields in a DTO class.** Why: the API doc and the code list the same fields, and nothing undeclared gets through.
2. **Unknown fields are rejected, in the body, the query and the path, at any depth.** This includes nested objects and list items (for example `pickup.foo`) and unknown query parameters. Reason `UNKNOWN_FIELD`. Why: it blocks a client sending a fake price, role or status.
3. **No silent type coercion.** A string is never turned into a number, a number never into a string, and nothing is trimmed, lowercased or given a default silently. Any default is a documented rule in the API doc. Why: a value changed on the way in may not mean what the client sent.
4. **Query and path values arrive as text.** Each one that must be a number is converted by an explicit converter (`ToInt` in `src/common/validation/`). It accepts only plain decimal digits and leaves anything else unchanged, so validation rejects it. The API doc names every converted field. Why: the conversion is visible and strict, unlike Nest's own conversion.
5. **Path, query and body values are read through a DTO object** (`@Param() params: Dto`, `@Query() query: Dto`, `@Body() body: Dto`). These patterns are banned in non-spec files under `src/`:
   - the built-in `Parse*Pipe`s: `ParseIntPipe`, `ParseFloatPipe`, `ParseBoolPipe`, `ParseArrayPipe`, `ParseUUIDPipe`, `ParseEnumPipe`;
   - named extraction: `@Param('x')`, `@Query('x')`, `@Body('x')`.

   A test (`src/common/validation/banned-patterns.spec.ts`) scans for them. `src/auth/auth.controller.ts` is on an allowlist marked "remove in F4".
   Why: Nest silently converts primitive-typed parameters (`''` becomes 0, `'0x10'` becomes 16, any Boolean that is not `'true'` becomes false), the built-in pipes cannot name the failing field, and a named body value skips the DTO rules entirely.
6. **The shared field types in section 2 are the only way to declare these fields.** The general-purpose validators `IsLatitude`, `IsLongitude`, `IsNumberString` and `IsISO8601` are not used directly. Why: `IsLatitude` accepts the string "12.5" and `IsISO8601` accepts time-zone offsets and date-only strings, which the rules below forbid.
7. **The reply never contains library text or the submitted value.** Each invalid field gets one fixed reason code (section 3). Why: library messages can change or reveal internals, and submitted values can be phone numbers or tokens.
8. **A client-sent derived value (price, distance, ETA, status, earnings) is an unknown field.** Why: the server computes derived values.
9. **A required field that is missing gives REQUIRED, never WRONG_TYPE.** The shared required types include `IsDefined`. Why: the app needs to know the field is absent, not that its type is wrong.
10. **Optional means "may be omitted".** `null` on an optional field is WRONG_TYPE unless the API doc marks the field nullable. `IsOptional` is not used for this, because it also lets `null` through. Why: `null` is a value the client chose to send and must not pass silently.
11. **A body is unusable only if it is missing, `null`, an array, or a bare string, number or boolean.** An unusable body gives INVALID_INPUT with `field` null and `details` omitted, and never crashes. Why: there is no field to point at, so a `details` entry would invent one; and a malformed request must always get the standard reply. **An empty object `{}` is a normal body** and is validated by the DTO, so the reply lists the missing required fields. Why: `{}` is well formed, and naming the missing fields tells the app more than a blanket error.
12. **Each API doc resolves the shared-type limits it uses before its code is written.** Every TO DECIDE in section 2 that the API needs (phone countries, money maximum, date range, page maximums, text lengths) is set in that API's doc. Why: the docs-first rule; code must not invent limits.
13. **Raw request access is banned in non-spec files under `src/`: `@Req()`, `@Request()`, `@Res()`, `@Response()` and `@Headers()`.** The same test scans for them, and the same allowlist applies (`src/auth/auth.controller.ts`, "remove in F4"). The authenticated user will come from a guard plus a custom parameter decorator, decided in F4. Why: `@Req()`, `@Request()` and `@Headers()` hand out raw input that bypasses the DTO, and `@Res()` and `@Response()` bypass the response envelope (decision 35).

## 2. Shared field types
| Type | Rule | Reason on failure | Why |
|---|---|---|---|
| lat | JSON number, finite, -90 to 90 inclusive. An API adds its own service-area bounds in its doc. | REQUIRED, WRONG_TYPE, OUT_OF_RANGE | Degrees are the map unit; a string such as "12.5" is not a number |
| lng | JSON number, finite, -180 to 180 inclusive. An API adds its own service-area bounds in its doc. | REQUIRED, WRONG_TYPE, OUT_OF_RANGE | As lat |
| phone | String in E.164 form: `+` then digits, no spaces or punctuation, not normalized. Allowed countries and length limits: TO DECIDE. | REQUIRED, WRONG_TYPE, INVALID_FORMAT | One canonical form, so the same number always matches the same account |
| money | JSON integer, in paise, 0 or more. Maximum: TO DECIDE. | REQUIRED, WRONG_TYPE, OUT_OF_RANGE | Integer paise avoids floating point errors (decision 9). Negative amounts are derived values, never client input |
| date | String in UTC: `YYYY-MM-DDTHH:mm:ss`, optional `.` and 1 to 3 digits, then `Z`. Must be a real calendar date and time. No offsets, no date-only. Years 0000 to 0099 are not accepted (JavaScript reads them as 1900 to 1999, so they cannot round-trip). Earliest and latest allowed values: TO DECIDE, set per API as functions. | REQUIRED, WRONG_TYPE, INVALID_FORMAT, OUT_OF_RANGE | UTC only, so the server never guesses a time zone |
| uuid | String in UUID form. Versions accepted (any version, or v4 only): TO DECIDE. | REQUIRED, WRONG_TYPE, INVALID_FORMAT | Ids are UUIDs |
| page | JSON integer or converted query value, 1 or more. Maximum page and default when omitted: TO DECIDE. | REQUIRED, WRONG_TYPE, OUT_OF_RANGE | Lists are paginated |
| pageSize | Integer, 1 or more, at most the maximum. Maximum and default: TO DECIDE. | REQUIRED, WRONG_TYPE, OUT_OF_RANGE | A cap keeps one request from reading a whole table |
| text | String with a minimum and maximum length set per field in the API doc (no default), counted in Unicode code points (an emoji counts as 1). The character U+0000 is rejected. No trimming. | REQUIRED, WRONG_TYPE, INVALID_FORMAT, TOO_SHORT, TOO_LONG | Code points match how users and Postgres count characters; Postgres cannot store U+0000 in text, so it is refused before it becomes a 500. Length limits bound storage and reply size |

A number that is not an integer where an integer is required counts as WRONG_TYPE.

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
| DATABASE_URL | Required. A `postgresql://` or `postgres://` URL that parses. | REQUIRED, INVALID_FORMAT |
| PORT | Optional, default 3000. Plain decimal digits, 1 to 65535. Converted to a number explicitly. | INVALID_FORMAT, OUT_OF_RANGE |
| NODE_ENV | Required. One of `development`, `test`, `production`. No default. | REQUIRED, NOT_ALLOWED |

- **The owner must add `NODE_ENV=development` to the local `.env`.** The agent never edits `.env`.
- A new environment variable needs a rule here and a line in `.env.example` in the same commit.
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
