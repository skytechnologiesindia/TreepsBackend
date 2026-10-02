# POST /v1/rides/estimate

Status: Draft (open TO DECIDE items). The L0 fake version is built (see below); the real API is not.

## L0 (temporary)

Status: built (commit dba5201). This section describes the first version of the route, which returns FAKE fixed values. It is temporary: the fake values stay until L3 replaces them with the real formula. Where it disagrees with the rest of this doc, this section wins for L0 only; the rest of the doc is the final contract.

### Scope
- **Real in L0:** the route `POST /v1/rides/estimate`, the request validation (the six fields below, unknown fields rejected) and the shape of the reply.
- **FAKE in L0:** every number in the reply. They are fixed constants. Nothing is computed: no route lookup, no fare engine, no database, no ETA calculation. The fake fares are not rates and must never be described or quoted as prices.
- **Not in L0:** login and role check, rate limit, the Ranchi bounds check, quote storage, unavailable tiers, modifiers and coupons.

### Open route: no login
L0 has no login and no role check; anyone who can reach the server can call it. **It must not be deployed until F4 (auth) is done.**

### Status code
The route replies **200**, not Nest's default 201 for POST, because the estimate creates nothing in L0. A later status change would break the apps, so it stays 200.

### Request in L0
All six fields are required. Unknown fields are rejected, including a client-sent `fareAmount`.

| Name | Rule in L0 |
|---|---|
| pickupLat, dropLat | JSON number, -90 to 90 (degree range only) |
| pickupLng, dropLng | JSON number, -180 to 180 (degree range only) |
| pickupAddress, dropAddress | Text, 1 to 200 characters (counted in Unicode code points). The 200 is an L0 placeholder, to be revisited. |

The Ranchi bounds are not checked in L0, so a point outside Ranchi still gets fake fares. The Ranchi bounds stay TO DECIDE for the real API.

### Reply in L0
The reply uses the standard success envelope. `tiers` has the keys MINI, SEDAN and XL.

| Field | L0 value |
|---|---|
| quoteId | A new random UUID on every call, **not stored**. It is not a valid quote and must not be booked against until L4. |
| expiresInSeconds | 180 (FAKE) |
| distanceMeters | 5000 (FAKE) |
| durationSeconds | 900 (FAKE) |
| pickupAddress, dropAddress | Echoed from the request, unchanged |
| tiers.MINI.fareAmount | 11100 paise (FAKE) |
| tiers.SEDAN.fareAmount | 22200 paise (FAKE) |
| tiers.XL.fareAmount | 33300 paise (FAKE) |
| tiers.<T>.breakdown.baseFare | the tier's whole `fareAmount` (FAKE) |
| tiers.<T>.breakdown.distanceCharge, timeCharge, minimumFareAdjustment, tax, roundingAdjustment | 0 (FAKE) |
| tiers.<T>.etaMinutes | 5 (FAKE, all tiers) |
| tiers.<T>.currency | "INR" |
| tiers.<T>.isAvailable | true for every tier (FAKE) |
| tiers.<T>.message | "" (empty text, FAKE) |
| tiers.<T>.seatCapacity | MINI 4, SEDAN 4, XL 6 (FAKE) |

The six breakdown lines still sum exactly to `fareAmount`, and each fake fare is a whole rupee amount (a multiple of 100 paise).

### Errors L0 can produce
| Code | HTTP status | When |
|---|---|---|
| INVALID_INPUT | 400 | Missing, wrongly typed, out-of-range or unknown field; `field` and `details` as in `standards/response-format.md` |
| INTERNAL_ERROR | 500 | Only if the code has a bug |

These codes cannot occur in L0 because nothing checks for them yet: OUT_OF_SERVICE_AREA, PICKUP_DROP_TOO_CLOSE, TRIP_TOO_LONG, ROUTE_UNAVAILABLE, PAYMENT_DUE, ACCOUNT_BANNED, RATE_LIMITED.

### Tests for L0
- Happy path: status 200, all three tiers, the fake values above, each breakdown sums to `fareAmount`.
- A missing field gives INVALID_INPUT.
- A wrong type gives INVALID_INPUT.
- A degree out of range gives INVALID_INPUT.
- An address that is empty or longer than 200 characters gives INVALID_INPUT.
- An unknown field, including a client-sent `fareAmount`, gives INVALID_INPUT.

## Purpose
A rider chooses a pickup and a drop. This API returns, for each tier, whether it is available, the pickup ETA and the exact fare, plus a quote id the rider can later book against. It lets the rider see the price before requesting a ride.

## Who calls it
Rider app. Auth: token (real JWT arrives in F4). Role: RIDER.

## Request fields
All request fields are bucket **Input**. The body may contain only these fields; unknown fields are rejected.

| Name | Type | Unit | Required? | Allowed range | Why it exists | Why this type/unit | Bucket | What breaks if wrong |
|---|---|---|---|---|---|---|---|---|
| pickupLat | number | degrees | Required | Inside Ranchi bounds (bounds: TO DECIDE) | Defines the pickup point for the route | TO DECIDE | Input | Wrong route and fare; out-of-area values must be stopped before any paid map call |
| pickupLng | number | degrees | Required | Inside Ranchi bounds (TO DECIDE) | As above | TO DECIDE | Input | As above |
| dropLat | number | degrees | Required | Inside Ranchi bounds (TO DECIDE) | Defines the drop point for the route | TO DECIDE | Input | As above |
| dropLng | number | degrees | Required | Inside Ranchi bounds (TO DECIDE) | As above | TO DECIDE | Input | As above |
| pickupAddress | string | text | Required | Max length: TO DECIDE | TO DECIDE | Text for display | Input | TO DECIDE |
| dropAddress | string | text | Required | Max length: TO DECIDE | TO DECIDE | Text for display | Input | TO DECIDE |

The client never sends distance, duration, price or ETA. Those are derived values and only the server computes them.

## Response fields
| Name | Type | Unit | Required? | Allowed range | Why it exists | Why this type/unit | Bucket | What breaks if wrong |
|---|---|---|---|---|---|---|---|---|
| quoteId | string (UUID) | n/a | Always | n/a | Lets the rider book against exactly the fare shown | Ids are UUIDs (CLAUDE.md) | Identity | Booking could charge a different fare than shown |
| expiresInSeconds | integer | seconds | Always | Value: TO DECIDE | A quote must not stay valid forever | TO DECIDE | Reference (config) | Stale fares get booked |
| distanceMeters | integer | meters | Always | 0 or more | Route distance behind the fare | TO DECIDE | Derived | Fare and trip-length checks are wrong |
| durationSeconds | integer | seconds | Always | 0 or more | Route duration behind the fare | TO DECIDE | Derived | Time charge is wrong |
| pickupAddress | string | text | Always | as request | TO DECIDE (echo of request, or resolved by server) | Text | TO DECIDE | TO DECIDE |
| dropAddress | string | text | Always | as request | TO DECIDE (echo of request, or resolved by server) | Text | TO DECIDE | TO DECIDE |
| tiers | object | n/a | Always | Keys MINI, SEDAN, XL | One result per tier | TO DECIDE | Derived | Rider cannot compare tiers |
| tiers.<T>.isAvailable | boolean | n/a | Always | true/false | Rider sees whether the tier can be booked | TO DECIDE | Derived | Rider books an unavailable tier. Availability rule: TO DECIDE |
| tiers.<T>.etaMinutes | integer | minutes | Always | Rule for an unavailable tier: TO DECIDE | Pickup wait time | TO DECIDE | Derived | Wrong expectation. Computation: TO DECIDE |
| tiers.<T>.message | string | text | Always | Wording: TO DECIDE | Explains availability | Text | Derived | Rider does not know why a tier is unavailable |
| tiers.<T>.fareAmount | integer | paise | Always | Whole rupees (a multiple of 100 paise) | The price the rider is shown | Integer paise: floating point cannot represent decimal money exactly | Derived | Wrong charge |
| tiers.<T>.currency | string | n/a | Always | "INR" | States the currency of the amounts | TO DECIDE | Reference | Amounts misread |
| tiers.<T>.seatCapacity | integer | seats | Always | 1 or more | Rider sees how many people fit | TO DECIDE | Reference | Overloaded ride |
| tiers.<T>.breakdown.baseFare | integer | paise | Always | TO DECIDE | Breakdown line | Integer paise | Derived | Breakdown does not sum |
| tiers.<T>.breakdown.distanceCharge | integer | paise | Always | TO DECIDE | Breakdown line | Integer paise | Derived | As above |
| tiers.<T>.breakdown.timeCharge | integer | paise | Always | TO DECIDE | Breakdown line | Integer paise | Derived | As above |
| tiers.<T>.breakdown.minimumFareAdjustment | integer | paise | Always | TO DECIDE | Amount added when the minimum fare applies | Integer paise | Derived | As above |
| tiers.<T>.breakdown.tax | integer | paise | Always | TO DECIDE | Breakdown line | Integer paise | Derived | As above |
| tiers.<T>.breakdown.roundingAdjustment | integer | paise | Always | TO DECIDE (may be negative) | Brings the total to whole rupees | Integer paise | Derived | As above |

The six breakdown lines sum exactly to `fareAmount`.

Open point: the fare engine has modifier and coupon steps, but the breakdown has no line for them. TO DECIDE (see `docs/engines/fare-engine.md`).

## Derived values
- `distanceMeters`, `durationSeconds`: from the route lookup (provider: TO DECIDE), computed on the server.
- `fareAmount` and `breakdown`: computed by the fare engine, in the fixed order in `docs/engines/fare-engine.md`, after the route.
- `isAvailable`, `etaMinutes`, `message`: rules TO DECIDE.

## Reference data used
Ranchi bounds, per-tier rates, tax rate, minimum fare, quote lifetime, thresholds for PICKUP_DROP_TOO_CLOSE and TRIP_TOO_LONG. Values: TBD. Versioning: TO DECIDE.

## State changes
- Before: no quote. After: a quote is stored under `quoteId`. Exact storage: TO DECIDE.
- Idempotency: whether a repeated call returns the same quote or a new one: TO DECIDE.
- Concurrency: TO DECIDE.

## Data stored
The quote: rider, inputs, derived values, reference-data version and expiry. Fields to snapshot: TO DECIDE. Reason for snapshotting: the fare booked must be the fare shown.

## Errors
Every error uses the error envelope in `docs/standards/response-format.md`, with `code`, `message` and `field`. `field` is null when the error is not about one input. HTTP statuses follow that doc's registry. Messages and UI reactions below are proposed.

| Code | HTTP status | When it happens | `field` marker | Rider-safe message (proposed) | App UI reaction (proposed) |
|---|---|---|---|---|---|
| OUT_OF_SERVICE_AREA | 422 | Pickup or drop is outside Ranchi bounds | pickupLat or dropLat | "We don't serve this area yet." | Highlight the point, ask for another |
| PICKUP_DROP_TOO_CLOSE | 422 | Distance below the minimum (value TO DECIDE) | dropLat | "Pickup and drop are too close." | Ask for a farther drop |
| TRIP_TOO_LONG | 422 | Distance above the maximum (value TO DECIDE) | dropLat | "This trip is too long for now." | Ask for a nearer drop |
| ROUTE_UNAVAILABLE | 422 | Route lookup failed or returned nothing | null | "We couldn't plan this route. Try again." | Show retry |
| PAYMENT_DUE | 403 | Rider has an unpaid balance | null | "Please clear your pending payment first." | Open the payment screen |
| ACCOUNT_BANNED | 403 | Rider account is banned | null | "This account can't book rides." | Show support contact |
| RATE_LIMITED | 429 | Too many requests | null | "Too many requests. Try again shortly." | Disable the button briefly |
| INVALID_INPUT | 400 | Missing, malformed or unknown field | the first invalid field (all are listed in `details`) | "Please check your input." | Highlight the field |

## Rate limit, logging and audit
Rate limit: TO DECIDE. Log fields: TO DECIDE. Audit events: TO DECIDE.

## Edge cases and known limitations
- A tier that is unavailable still appears in `tiers` with `isAvailable: false` and a `message`. Its fare and ETA values: TO DECIDE.
- The estimate needs real auth (F4) before deployment.
- Coupons and modifiers: see the open point above.

## Required tests
- Happy path: all three tiers returned; each breakdown sums to `fareAmount`.
- No token.
- Wrong role.
- Blocked account (ACCOUNT_BANNED) and PAYMENT_DUE.
- Invalid input: missing field, wrong type, out-of-range coordinates.
- Unknown field, including a client-sent `fareAmount`, is rejected.
- Duplicate call (behavior per the idempotency decision).
- Race condition: TO DECIDE once the state changes are decided.
- Upstream failure: route lookup down gives ROUTE_UNAVAILABLE.
- Each error code: OUT_OF_SERVICE_AREA, PICKUP_DROP_TOO_CLOSE, TRIP_TOO_LONG, RATE_LIMITED.

## Changelog
| Date | What changed | Why |
|---|---|---|
| 2026-09-29 | Contract frozen: fields, tiers, breakdown, error codes | Docs-first rule |
| 2026-09-29 | Status changed from Frozen to Draft | Has open TO DECIDE items that must be resolved before it is frozen |
| 2026-09-29 | Error statuses aligned with `standards/response-format.md`: ROUTE_UNAVAILABLE 503 to 422, PAYMENT_DUE 402 to 403; `field` is null when not about one input; INVALID_INPUT points at the first invalid field | Error registry decided in F3.2 |
| 2026-09-30 | Added the "L0 (temporary)" section: fake fixed values, status 200, no login, degree ranges only, address 1 to 200 | First version of the route, owner's answers of 2026-09-30 |
| 2026-10-02 | L0 marked built (commit dba5201); the five open L0 answers filled in: `quoteId` new random UUID per call and not stored, addresses echoed, `isAvailable` true, `message` empty, `seatCapacity` 4, 4, 6 (all FAKE) | The route was built and tested |
