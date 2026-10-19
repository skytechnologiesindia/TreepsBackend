# GET /v1/driver/me

Status: BUILT 2026-10-16. Shape approved by the owner on 2026-10-16 ("keep it simple"). Items marked TO DECIDE have no decision yet.

## Purpose

The driver app calls this every time it opens, to learn the driver's current status and which screen to show. The status changes on the server while the app is closed (for example an admin approves the driver), so the app must ask.

Kept small on purpose. A new part of the driver (subscription, vehicle, earnings) is added here only when that part is built.

## Who calls it

The driver app, with the driver's session token. A rider or admin token gets 403. A suspended, blocked or deleted driver gets `ACCOUNT_BANNED` from the session guard and never reaches this route.

## Request

`GET /v1/driver/me`. No body, no query. The driver comes from the token only.

## Response

```json
{
  "success": true,
  "data": {
    "driver": {
      "id": "uuid",
      "phoneNumber": "+919477172214",
      "status": "DOCUMENTS_PENDING",
      "createdAt": "2026-10-16T14:47:09.070Z"
    },
    "nextStep": "FIX_DOCUMENTS",
    "documents": [
      { "key": "DRIVING_LICENCE", "status": "REJECTED", "reviewNote": "Back photo is blurry" },
      { "key": "PERMIT", "status": "APPROVED", "reviewNote": null }
    ]
  }
}
```

- `driver` is the same object `verify-otp` returns (decision 164). `createdAtIst` is added by the server as everywhere.
- `documents` lists every step the driver has sent, in the fixed step order, with its review status and the admin's note. Empty before the first submit. Document numbers and photos are never in this reply.

### `nextStep`: which screen the app shows

| nextStep | When | App shows |
|---|---|---|
| `SUBMIT_DOCUMENTS` | `DOCUMENTS_PENDING`, never submitted | The document screens |
| `FIX_DOCUMENTS` | `DOCUMENTS_PENDING`, submitted before (sent back by an admin) | Only the steps with status `REJECTED`, with their notes |
| `WAIT_FOR_REVIEW` | `UNDER_REVIEW` | "Your application is under review" |
| `READY` | `APPROVED` | The home screen |
| `REJECTED` | `REJECTED` | "Your application was rejected" |

The server decides `nextStep`, so the app never repeats the rules.

## Errors

| Code | HTTP | When |
|---|---|---|
| UNAUTHORIZED | 401 | No token, bad or expired token, or the driver no longer exists |
| FORBIDDEN | 403 | A rider token |
| ACCOUNT_BANNED | 403 | The driver is suspended, blocked or deleted |
| RATE_LIMITED | 429 | More than 600 calls an hour from one IP (proposal, TO DECIDE; high because many phones share one mobile-network IP) |

## Data stored

Nothing. A read.

## Tests (built)

`src/modules/driver-auth/driver-me.http.spec.ts`: each `nextStep`, the documents list and its order, no number or photo in the reply, no token, rider token, banned driver, deleted driver.

## Changelog

| Date | What changed | Why |
|---|---|---|
| 2026-10-07 | Draft created (not built); no profile flag because the Driver has none | Owner instruction of 2026-10-07 (decision 164) |
| 2026-10-09 | Auth is now a server-side session (decisions 174 to 178); still deferred until the driver submit-for-review step | Server-side sessions |
| 2026-10-16 | Rewritten and built: `driver` as before, plus `nextStep` and `documents`. Banned drivers are refused by the guard (`ACCOUNT_BANNED`), as built since decision 176 | Owner approved the simple shape; the submit step is built |
