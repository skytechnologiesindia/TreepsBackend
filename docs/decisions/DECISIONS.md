# Decisions

Format: date, decision, reason. "TO DECIDE" means the reason is not recorded yet.

## 2026-09-29

1. **Project name is Treeps** (previously XCab, then SkyRides).
   Reason: the product was named Treeps by the owner.
2. **Stack: NestJS 12, Prisma 7.10, PostgreSQL, TypeScript.**
   Reason: existing project stack, kept as is.
3. **Prisma config is `prisma.config.ts` and points at the `prisma/` folder.**
   Reason: Prisma 7 rejects `url` in the schema file, and pointing at the folder is what makes models split across files (`schema.prisma`, `models/rider.prisma`) visible.
4. **Dev database `treeps_db` was emptied after a `pg_dump` backup (stored outside the repo). Old `User`, `OtpVerification` and `Role` were dropped and the init migration applied.**
   Reason: the old tables had no migration history, so `migrate dev` would have demanded a reset. The only data was one mock-login row.
5. **Never use `migrate reset`, `db push` or `--force`.**
   Reason: they can destroy data.
6. **Launch scope: Ranchi only; tiers MINI, SEDAN, XL.**
   Reason: TO DECIDE.
7. **The estimate API is built in layers, each switchable and done only when its check passes.**
   Reason: TO DECIDE.
8. **Every variable is Input, Identity, Reference or Derived. Derived values are computed only by the server.**
   Reason: a client-sent price, distance, ETA, status or earnings could be forged; the server is the only trusted source.
9. **Money is stored as integer paise.**
   Reason: floating point rounding errors (for example 0.1 + 0.2) make totals disagree with breakdowns.
10. **Unknown request fields are rejected.**
    Reason: blocks a client sending a fake price or role.
11. **Every API and engine has a doc created from its template BEFORE its code is written.**
    Reason: TO DECIDE.
