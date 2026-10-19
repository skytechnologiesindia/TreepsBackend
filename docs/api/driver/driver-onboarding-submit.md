# POST /v1/driver/onboarding

Status: BUILT 2026-10-16 on the owner's instruction (decisions 185 to 187). Items marked TO DECIDE have no decision yet. The date and age limits below are proposals the owner can change.

The controller writes `@Controller('driver/onboarding')` and never `v1`. Sibling doc: `driver-document-requirements.md` (the list of steps this API accepts).

## Purpose

The driver sends the whole application in one go: the typed answers and every photo. The server checks it, keeps the photos, saves the answers, and moves the driver to `UNDER_REVIEW` so an admin can review it.

Nothing is uploaded before this call. If the driver quits before pressing Submit, nothing exists on the server.

## Who calls it

The driver app, after login. It needs the session token (`Authorization: Bearer <token>`). The driver must be `DOCUMENTS_PENDING`. Any other status gets `CONFLICT`.

Rate limit: 10 an hour per IP (TO DECIDE).

## The request

`multipart/form-data`. One text part and the photo parts.

### Part `data` (JSON text)

```json
{
  "steps": [
    { "key": "VEHICLE", "option": "CAR" },
    { "key": "PERSONAL_INFO", "fullName": "Rahul Kumar", "dateOfBirth": "1995-04-12", "gender": "MALE" },
    { "key": "PERSONAL_IDENTITY", "option": "PAN_CARD", "number": "ABCDE1234F" },
    { "key": "DRIVING_LICENCE", "number": "JH0120190012345", "expiryDate": "2034-08-30" },
    { "key": "VEHICLE_NUMBER", "option": "VEHICLE_RC", "number": "JH01AB1234" },
    { "key": "PERMIT", "number": "PRM-2026-8841", "expiryDate": "2027-03-31" },
    { "key": "CAB_INSURANCE", "number": "POL-55120077", "expiryDate": "2027-01-15" },
    { "key": "FITNESS", "number": "FIT-90321", "expiryDate": "2027-06-10" }
  ]
}
```

Nothing else is accepted inside `data`. An unknown field is refused. The app never sends a status.

### What each step takes

| Step | Option | Typed fields | Photos |
|---|---|---|---|
| `VEHICLE` | `CAR`, `BIKE`, `AUTO` | none | none |
| `PERSONAL_INFO` | none | `fullName`, `dateOfBirth`, `gender` | `PERSONAL_INFO_PHOTO` |
| `PERSONAL_IDENTITY` | `AADHAAR`, `PAN_CARD` | `number` | `PERSONAL_IDENTITY_FRONT` |
| `DRIVING_LICENCE` | none | `number`, `expiryDate` | `DRIVING_LICENCE_FRONT`, `DRIVING_LICENCE_BACK` |
| `VEHICLE_NUMBER` | `VEHICLE_RC`, `ROAD_TAX` | `number` | `VEHICLE_NUMBER_FRONT`, `VEHICLE_NUMBER_BACK` |
| `PERMIT` | none | `number`, `expiryDate` | `PERMIT_FRONT`, `PERMIT_BACK` |
| `CAB_INSURANCE` | none | `number`, `expiryDate` | `CAB_INSURANCE_FRONT` |
| `FITNESS` | none | `number`, `expiryDate` | `FITNESS_FRONT` |

TO DECIDE: whether `VEHICLE_NUMBER` also needs an expiry date, and whether `FITNESS` needs one. They are asked here as in the table.

### Field rules

| Field | Rule |
|---|---|
| `fullName` | 2 to 50 letters, same as the rider name |
| `dateOfBirth` | `YYYY-MM-DD`, a real date, the driver must be at least 18 and at most 80 years old |
| `gender` | `MALE`, `FEMALE` or `OTHER` |
| `number` | 1 to 30 characters, no check of the real format (TO DECIDE) |
| `expiryDate` | `YYYY-MM-DD`, a real date, today or later, at most 50 years ahead |
| `option` | One of the options the requirements API sent for that step |

### Photo rules

- JPG or PNG only. The server reads the first bytes of the file to be sure. It does not trust the file name or the type the app sends.
- At most 2 MB each, and at most 12 photos in one request.
- A photo part the step does not take is refused.

## What the server checks (in this order, before saving anything)

1. The login, and that the driver is `DOCUMENTS_PENDING`.
2. `data` is a valid JSON text with only the allowed fields.
3. Every `key` is a step that is switched on right now (the requirements list), with no key twice.
4. Every step has its typed fields and photos, and nothing extra.
5. Every step that is required right now is present. A step the driver already sent earlier, and that was not rejected, counts as present.
6. The photos are real JPG or PNG files within the size limit.

If any check fails, the reply is an error and **nothing is stored**.

## What the server saves

1. The photos, in storage, one path each (`drivers/<driver id>/<step>-<side>-<random>.jpg`).
2. One row per step in `DriverDocument` (option, number, expiry date, the photo paths, status `PENDING`).
3. On the driver: name, date of birth, gender, profile photo path, `submittedAt`, and the status `UNDER_REVIEW`.

Steps 2 and 3 are one database transaction. If it fails, the photos stored in step 1 are deleted.

The database keeps the photo **path**, never a link. A temporary link for the admin is made when the admin opens the application (admin side: not built).

## Reply

HTTP 200:

```json
{ "success": true, "data": { "status": "UNDER_REVIEW" }, "requestId": "..." }
```

## Errors

| Code | HTTP | When | What the app does |
|---|---|---|---|
| `UNAUTHORIZED` | 401 | No, bad or expired token | Go to login |
| `FORBIDDEN` | 403 | A rider's token | Should not happen |
| `ACCOUNT_BANNED` | 403 | Driver is suspended or blocked | Support screen |
| `INVALID_INPUT` | 400 | Any check above failed. `details` lists the field and a fixed reason, for example `data.steps.2.number` `REQUIRED` | Show the problem on that step |
| `CONFLICT` | 409 | The driver is not `DOCUMENTS_PENDING` (already submitted) | Refresh the status |
| `RATE_LIMITED` | 429 | Too many tries | Wait and retry |
| `INTERNAL_ERROR` | 500 | Storage or database failed. Nothing was kept | Retry |

For a missing photo the `field` is the part name, for example `DRIVING_LICENCE_BACK`, with the reason `REQUIRED`. For a required step that is missing, the `field` is `data.steps.<KEY>`, for example `data.steps.FITNESS`, with the reason `REQUIRED`. A photo that is too big, or a part with a name no step uses, is `INVALID_INPUT` with no `details`.

## Safety

- Aadhaar and PAN numbers are never logged and never sent back to the app (decision 187). The admin side will show them.
- Photos are private. There is no public link.
- The server sets the status. A status sent by the app is an unknown field.

## Open points (TO DECIDE)

- A legal check of storing the full Aadhaar number (decision 187).
- The notifications ("under review", "approved", "rejected", "sent back"). Not part of this API yet.
- Moving from the local folder to S3.
- Expiry date for `VEHICLE_NUMBER` and `FITNESS`.
- Checking the real format of a licence, vehicle or PAN number.
- Whether `BIKE` and `AUTO` stay in the `VEHICLE` options (launch is cars only).

## Tests (built)

In `src/modules/driver-documents/`: `driver-onboarding.http.spec.ts` (the whole request through HTTP with an in-memory database and storage), `driver-onboarding.pg.spec.ts` (real Postgres, including two submits at the same moment; run with `RUN_PG_TESTS=1`, uses the scratch database `treeps_scratch_onboarding`, never `treeps_db`), and `src/common/validation/calendar-date.spec.ts`. They cover:

- A full valid submit saves the rows, the files, and moves the driver to `UNDER_REVIEW`.
- A missing required step, a missing photo, an unknown field and a bad date are each `INVALID_INPUT`, and nothing is stored.
- A photo that is not a real JPG or PNG is refused.
- A second submit is `CONFLICT`.
- If the database save fails, the stored photos are deleted.
- No token is 401 and a rider token is 403.

## Changelog

| Date | What changed | Why |
|---|---|---|
| 2026-10-16 | First version | Owner instructions, decisions 185 to 187 |
| 2026-10-18 | An option that is `COMING_SOON` in the requirements (for example `BIKE`) is refused with `NOT_ALLOWED`, like a switched-off one | Decision 190 |
