# GET /v1/driver/documents/requirements

Status: BUILT. Options with a status (`AVAILABLE`, `COMING_SOON`) approved by the owner on 2026-10-18 (decision 190).

## Purpose

This API tells the driver app which onboarding steps to show, and in what order.

The server only sends keys. The app has its own screen for each key and its own label text, so the server sends no label. Because of this, the owner can switch a step or one of its choices on or off on the server without an app update.

Example:

- Today the list has 8 steps, so the app shows 8 rows.
- The owner switches `FITNESS` off.
- The next time the driver opens the screen, the list has 7 steps, and the fitness row is gone.

## Response

`GET /v1/driver/documents/requirements`, no body. Driver login token needed.

```json
{
  "success": true,
  "data": {
    "steps": [
      {
        "key": "VEHICLE",
        "required": true,
        "options": [
          { "value": "CAR", "status": "AVAILABLE" },
          { "value": "BIKE", "status": "COMING_SOON" },
          { "value": "AUTO", "status": "COMING_SOON" }
        ]
      },
      { "key": "PERSONAL_INFO", "required": true },
      {
        "key": "PERSONAL_IDENTITY",
        "required": true,
        "options": [
          { "value": "AADHAAR", "status": "AVAILABLE" },
          { "value": "PAN_CARD", "status": "AVAILABLE" }
        ]
      },
      { "key": "DRIVING_LICENCE", "required": true },
      {
        "key": "VEHICLE_NUMBER",
        "required": true,
        "options": [
          { "value": "VEHICLE_RC", "status": "AVAILABLE" },
          { "value": "ROAD_TAX", "status": "AVAILABLE" }
        ]
      },
      { "key": "PERMIT", "required": true },
      { "key": "CAB_INSURANCE", "required": true },
      { "key": "FITNESS", "required": true }
    ]
  },
  "requestId": "..."
}
```

Rules:

- A key in the list means the row shows. A key that is missing means the row is gone.
- The order of the list is the order of the rows.
- `required: false` means the row shows but the driver may skip it.
- `options` is only on steps where the driver chooses one. Every step with options uses the same shape.
- An option's `status`:
  - `AVAILABLE`: the driver can pick it.
  - `COMING_SOON`: the app shows it, disabled, with a "Coming soon" label. The submit refuses it with `NOT_ALLOWED`.
  - An option that is switched off completely is not sent at all.
- Options come in a fixed order (the order the server knows them in), available or not, so the cards do not jump around when one becomes available.
- The app translates the label from the key and the value. The server sends no label text.

## Where the options are set

The table `DocumentRequirement`, one row per step:

| Column | Meaning |
|---|---|
| `options` | The options the driver can pick (`AVAILABLE`) |
| `comingSoonOptions` | The options shown as `COMING_SOON` |

An option in neither column is hidden. To launch bikes: move `BIKE` from `comingSoonOptions` to `options`. An option listed in both is treated as available. A value the server does not know for that step is ignored.

## Errors

| Code | HTTP | When |
|---|---|---|
| UNAUTHORIZED | 401 | No token, bad or expired token |
| FORBIDDEN | 403 | A rider or admin token |
| ACCOUNT_BANNED | 403 | The driver is suspended or blocked |
| RATE_LIMITED | 429 | More than 120 calls an hour from one IP |

## Open points (TO DECIDE)

- Which inputs a step needs (number, expiry date, back photo) is not in this reply. It belongs to the submit API (`driver-onboarding-submit.md`).

## Changelog

| Date | What changed | Why |
|---|---|---|
| 2026-10-12 | Draft created; options as plain keys | Owner, section by section |
| 2026-10-16 | Built, with the rate limit of 120 an hour per IP | Driver onboarding |
| 2026-10-18 | **Breaking for the app:** each option is now `{ value, status }` with `AVAILABLE` or `COMING_SOON`; new column `comingSoonOptions`; `BIKE` and `AUTO` set to coming soon | Owner: show bike and auto as "coming soon" cards and switch them on later from the backend (decision 190) |
