# <METHOD> /v1/<path>

Status: Draft | Frozen | Implemented | Deprecated

## Purpose
One paragraph: what problem this API solves.

## Who calls it
Caller (rider app / driver app / admin), auth method, role required.

## Request fields
| Name | Type | Unit | Required? | Allowed range | Why it exists | Why this type/unit | Bucket | What breaks if wrong |
|---|---|---|---|---|---|---|---|---|

Bucket = Input, Identity, Reference or Derived.

## Response fields
| Name | Type | Unit | Required? | Allowed range | Why it exists | Why this type/unit | Bucket | What breaks if wrong |
|---|---|---|---|---|---|---|---|---|

## Derived values
For each: exact formula or rule, where it is computed, and the order of computation.

## Reference data used
Config or DB values used, and how they are versioned.

## State changes
Before and after. Idempotency. Concurrency risks and how they are handled.

## Data stored
What is stored and what is snapshotted, and why.

## Errors
| Code | HTTP status | When it happens | `field` marker | Rider-safe message | How the app UI should react |
|---|---|---|---|---|---|

## Rate limit, logging and audit
Rate limit. Log fields. Audit events.

## Edge cases and known limitations

## Required tests
- Happy path
- No token
- Wrong role
- Blocked account
- Invalid input
- Unknown field
- Duplicate call
- Race condition
- Upstream failure

## Changelog
| Date | What changed | Why |
|---|---|---|
