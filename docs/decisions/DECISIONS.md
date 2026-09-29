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
    Reason: this is a production app handling money and rider safety, so every API and engine must record why each field and rule exists; without that, later changes cannot be made safely.
12. **Line endings are LF, enforced by `.gitattributes` (`* text=auto eol=lf`).**
    Reason: Windows uses CRLF and Linux servers and CI use LF; mixed endings produce whole-file diffs and can break shell scripts on Linux.
13. **The agent tool folders (`.agents/`, `.windsurf/`, `.claude/skills/`) are no longer tracked.**
    Reason: they were the same 71 skill files stored three times (213 of 256 tracked files), and the `.claude` and `.windsurf` copies are links to `.agents`.
14. **`.claude/skills/` and `.claude/settings.local.json` are ignored, but a shared `.claude/settings.json` can still be committed.**
    Reason: skills and local settings are personal tooling, while shared settings are worth versioning.
15. **`skills-lock.json` stays tracked.**
    Reason: it records which skills are installed, so they can be reinstalled.
16. **`.env.example` was added, and the Firebase variable names are left out until F4 decides the auth flow.**
    Reason: it documents the required variables without secrets. The Firebase variables appear only in commented-out code.
