# Fare Engine

Status: Draft

## Purpose
Computes the fare for each tier (MINI, SEDAN, XL) for a trip. Used by the estimate API (`docs/api/estimate.md`).

## Inputs
| Name | Type | Unit | Source | Bucket |
|---|---|---|---|---|
| Route distance | integer | meters | Route lookup (provider: TO DECIDE) | Derived |
| Route duration | integer | seconds | Route lookup (provider: TO DECIDE) | Derived |
| Pickup and drop zone flags | TO DECIDE | TO DECIDE | Zone reference data (TO DECIDE) | Reference |
| Time flags | TO DECIDE | TO DECIDE | Server clock + reference data (TO DECIDE) | Derived |
| Tier | enum MINI, SEDAN, XL | n/a | Request / loop over all tiers | Input |
| Coupon | TO DECIDE | TO DECIDE | TO DECIDE (not in the estimate request today) | TO DECIDE |

## Reference data and versioning
Per-tier rates, tax rate, minimum fare, zone and time rules. Values: TBD, to be defined. Versioning: TO DECIDE.

## Order of steps
1. **Route.** Get distance and duration.
2. **Zone flags.** Reason for this position: TO DECIDE.
3. **Time flags.** Reason for this position: TO DECIDE.
4. **Base fare per tier** = base + distance charge + time charge. Reason for this position: TO DECIDE.
5. **Modifiers.** Reason for this position: TO DECIDE.
6. **Minimum fare check.** Reason for this position: TO DECIDE.
7. **Coupon.** Applied after the minimum fare check so a coupon can never take the fare below the minimum fare.
8. **Tax.** Reason for this position: TO DECIDE.
9. **Rounding to whole rupees.** Last, so the final fare is a whole rupee amount and the breakdown can be made to sum exactly to it.

## Rounding and money rules
- Money is integer paise (see DECISIONS).
- The final fare is rounded to whole rupees (a multiple of 100 paise).
- The breakdown must sum exactly to the final fare.
- Rounding mode and intermediate rounding: TO DECIDE.

## Rules and modifiers
Each layer is switchable. Switch names and where they live: TO DECIDE.

| Rule | What it does | Why | On/off switch |
|---|---|---|---|
| Zone flags | TBD, to be defined | TO DECIDE | TO DECIDE |
| Time flags | TBD, to be defined | TO DECIDE | TO DECIDE |
| Modifiers | TBD, to be defined | TO DECIDE | TO DECIDE |
| Minimum fare | Raises the fare to the tier minimum | TO DECIDE | TO DECIDE |
| Coupon | Reduces the fare, never below minimum fare | Coupons must not undercut the minimum | TO DECIDE |
| Tax | TBD, to be defined | TO DECIDE | TO DECIDE |
| Rounding | Rounds to whole rupees | Whole-rupee fares | TO DECIDE |

## Open questions
- The estimate breakdown has lines for base fare, distance charge, time charge, minimum fare adjustment, tax and rounding adjustment. It has no line for modifiers or coupon. TO DECIDE: fold them into existing lines, or add lines.

## Failure modes and fallbacks
| Failure | What the engine does | Error code |
|---|---|---|
| Route lookup fails | TO DECIDE | ROUTE_UNAVAILABLE (see estimate doc) |
| Missing rate config for a tier | TO DECIDE | TO DECIDE |

## Worked examples
TBD. They need real rate values. Each example must show every step and end with the check that the breakdown sums to the fare.

## What is snapshotted
The final fare, every breakdown line, and the reference-data version used. Storage details: TO DECIDE.

## Tests
TO DECIDE. At minimum: breakdown sums exactly to the fare; coupon never goes below the minimum; every switch on and off; rounding at boundaries.

## Changelog
| Date | What changed | Why |
|---|---|---|
| 2026-09-29 | Draft created from decided order | Docs-first rule |
