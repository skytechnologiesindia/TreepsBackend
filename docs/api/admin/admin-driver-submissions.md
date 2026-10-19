# GET /v1/admin/driver-submissions and GET /v1/admin/driver-submissions/:driverId

Status: BUILT 2026-10-16 on the owner's instruction (decision 188). Items marked TO DECIDE have no decision yet. The migration is applied to scratch databases only, not to `treeps_db`.

## Purpose

The admin sees how many drivers have submitted their onboarding application, and opens any one of them to see everything that driver typed and uploaded. This step is read-only. Approve, reject and send back come in the next step.

A "submission" is a driver who has pressed Submit at least once (`submittedAt` is set). A driver who is still filling the form has no submission.

## Who calls it

The admin web panel, with the token from `POST /v1/admin/auth/login`. A rider or driver token gets 403. No token gets 401.

## 1. The list: `GET /v1/admin/driver-submissions`

### Request (query string, all optional)

| Name | Rule | Default | Why |
|---|---|---|---|
| status | One of `UNDER_REVIEW`, `APPROVED`, `REJECTED`, `DOCUMENTS_PENDING`, `SUSPENDED`, `BLOCKED` | all submitted drivers | Filter. `DOCUMENTS_PENDING` here means sent back for fixes after a submit. |
| page | Whole number, 1 or more | 1 | Page number |
| pageSize | Whole number, 1 to 100 | 20 | Page size (TO DECIDE; the pagination shape is also still TO DECIDE since decision 119) |

Sorted by `submittedAt`, newest first. Unknown query fields are refused with `INVALID_INPUT`.

### Response

```json
{
  "success": true,
  "data": {
    "counts": { "total": 42, "UNDER_REVIEW": 30, "APPROVED": 9, "REJECTED": 2, "DOCUMENTS_PENDING": 1, "SUSPENDED": 0, "BLOCKED": 0 },
    "page": 1,
    "pageSize": 20,
    "total": 30,
    "items": [
      {
        "driverId": "uuid",
        "phoneNumber": "+919477172214",
        "fullName": "Rahul Kumar",
        "status": "UNDER_REVIEW",
        "submittedAt": "2026-10-16T14:47:09.070Z",
        "submittedAtIst": "16-10-2026 20:17:09",
        "documents": { "total": 7, "pending": 7, "approved": 0, "rejected": 0 }
      }
    ]
  }
}
```

`total` is the number of drivers that match the filter (so the panel can work out the number of pages). `counts` always counts all submitted drivers (a deleted driver is never counted), so the panel can show the tabs with numbers. The list has no photos, to stay light.

## 2. One submission: `GET /v1/admin/driver-submissions/:driverId`

`driverId` must be a UUID, else `INVALID_INPUT`. A driver that does not exist, or never submitted, is `NOT_FOUND`.

### Response

Everything the driver sent, as the server stored it:

```json
{
  "success": true,
  "data": {
    "driverId": "uuid",
    "phoneNumber": "+919477172214",
    "status": "UNDER_REVIEW",
    "submittedAt": "2026-10-16T14:47:09.070Z",
    "submittedAtIst": "16-10-2026 20:17:09",
    "profile": {
      "fullName": "Rahul Kumar",
      "dateOfBirth": "1996-10-16",
      "gender": "MALE",
      "photo": { "contentType": "image/jpeg", "data": "<base64>" }
    },
    "documents": [
      {
        "key": "DRIVING_LICENCE",
        "option": null,
        "number": "JH0120190012345",
        "expiryDate": "2031-10-16",
        "status": "PENDING",
        "reviewNote": null,
        "front": { "contentType": "image/jpeg", "data": "<base64>" },
        "back": { "contentType": "image/png", "data": "<base64>" }
      }
    ]
  }
}
```

- `documents` is in the fixed step order (`VEHICLE`, `PERSONAL_IDENTITY`, `DRIVING_LICENCE`, `VEHICLE_NUMBER`, `PERMIT`, `CAB_INSURANCE`, `FITNESS`). A step the driver did not send is not in the list.
- `number` is returned in full, including the Aadhaar number, because the admin must check it against the photo. This is the one place it is shown. **Legal check still open (decision 187).**
- A photo the step does not have is `null`.

### How the photos are returned (owner decision 2026-10-16: no expiry, everything in the submission)

The photos are inside the response as base64 text, with their content type, so the admin sees the whole submission in one call and there is no link to expire or leak. No file stream is used (rule 13 kept).

Cost, honestly: a full application has 10 photos of up to 2 MB each, so one response can reach about 27 MB (base64 adds a third). That is acceptable for one admin opening one driver, but the panel must not open many at once. If it becomes slow, the fix is a separate admin-only photo route, which needs your approval under rule 13. TO DECIDE then, not now.

The server needs a new `read(path)` on the file storage class (today it only saves and deletes), so the same code works for the local folder now and S3 later. A photo file that is missing on disk is returned as `null` and logged, and does not fail the whole response.

## Errors

| Code | HTTP | When |
|---|---|---|
| INVALID_INPUT | 400 | Bad query value, unknown query field, `driverId` not a UUID |
| UNAUTHORIZED | 401 | No or expired admin token |
| FORBIDDEN | 403 | A rider or driver token |
| NOT_FOUND | 404 | Detail only: no such driver, or the driver never submitted |
| RATE_LIMITED | 429 | Too many calls (proposal: 600 an hour per IP; TO DECIDE) |

## Data stored and logging

Nothing is changed (read-only). Each call to the detail route writes an audit log line: admin id, driver id, time. The log never contains the number, the name, the photos or the token. (Whether to keep this audit in a table instead is TO DECIDE.)

## Edge cases

- A driver who was sent back and submitted again shows only the latest data. Old versions are not kept (same as the submit doc).
- Two admins looking at the same driver is fine, since nothing is written.

## Tests (built)

`src/modules/admin/admin.pg.spec.ts` (real Postgres, `RUN_PG_TESTS=1`). A live simulation also ran against the running server: 6 drivers submitted, 2 more logged in without submitting, the admin listed and opened all of them, and every typed field and every photo came back byte for byte. They cover:


Happy path for both routes. Counts correct for every status. Filter and page. Wrong page size. Unknown query field. No token. Rider token. Driver token. Inactive admin. Driver never submitted gives NOT_FOUND. Bad UUID. A missing photo file gives `null` without failing. The number and photos appear only on the detail route, never in the list. A real-Postgres test for the counts and the sort.

## Changelog

| Date | What changed | Why |
|---|---|---|
| 2026-10-16 | Draft created | Owner asked for an admin view of all driver submissions with everything each driver filled and uploaded; photos inline, no expiry |
| 2026-10-16 | Built. Added `total` to the list reply; deleted drivers are never counted or shown | Owner told Claude to build and simulate it |
