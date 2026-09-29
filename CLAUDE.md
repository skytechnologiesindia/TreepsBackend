# Treeps Backend: Standing Rules

Treeps is a ride-hailing backend (rider app + driver app).
Stack: NestJS 12, Prisma 7.10, PostgreSQL, TypeScript (ESM).
Launch scope: Ranchi only; tiers MINI, SEDAN, XL.
Docs start at `docs/README.md`. Progress: `docs/progress/TRACKER.md`. Decisions: `docs/decisions/DECISIONS.md`.

## Architecture
- Modular monolith. Today `src/auth/` and `src/prisma/` exist. New domains go under `src/modules/<domain>/` (module, controller, service, DTOs).
- Admin visibility: from the first user-facing domain after the estimate API, each domain ships admin audit/tracking/metrics endpoints with it.

## Teaching (the owner knows Express/Mongoose, not NestJS/Prisma)
1. Before using any NestJS or Prisma concept for the first time, explain it in at most 3 lines in Express/Mongoose terms. After each change, give a "What changed" summary that maps each change to its Express equivalent.
2. Build one step at a time. No large code dumps.

## Docs first
3. A step is not done until the matching docs are updated.
4. No API or engine is built until its doc exists (from `docs/templates/`) and the owner has approved it.
5. A change to an API's fields, errors or behavior is not done until its doc and changelog are updated.
6. Never guess a reason or a value in docs. Write "TO DECIDE".

## Safety
7. Never run `prisma migrate reset`, `prisma db push`, or any `--force` flag. Never drop or delete data without a backup and the owner's approval.
8. Never print secrets. Never commit `.env`.
9. Commit only when the owner says so or a step names a commit.
10. Stay in scope. Report issues noticed; do not fix them.

## Conventions
11. Money is integer paise. Timestamps are UTC. Ids are UUIDs. Fields are camelCase. Enum values are UPPERCASE. API paths include `/v1`.
12. The client never sends derived values (price, distance, ETA, status, earnings). The server computes them.
13. Controllers never use `@Res()`, and never return a `StreamableFile` or other raw stream, without the owner's approval; both bypass or break the response envelope.
