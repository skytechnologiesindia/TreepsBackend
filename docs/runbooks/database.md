# Database Runbook

## Dev database
- Name: `treeps_db`, PostgreSQL on localhost:5432, schema `public`.
- Connection string: `DATABASE_URL` in `.env` (never commit; never print).
- Prisma reads it via `prisma.config.ts`.

## The never-reset rule
Never run `prisma migrate reset`, `prisma db push` or any `--force` flag. If Prisma mentions drift or offers a reset, stop and ask the owner.
Never drop or delete data without a backup and the owner's approval.

## Backup (pattern)
Save the file outside the repo so it can never be committed.
```bash
pg_dump --dbname="<connection string without ?schema=public>" \
  --format=custom --no-owner \
  --file="<folder outside repo>/treeps_db-backup-<date>.dump"
pg_restore --list "<file>"   # check the file is readable
```
- The `?schema=public` part of `DATABASE_URL` must be removed; `pg_dump` and `psql` reject it.
- Current backup: `C:\Users\HP\Documents\treeps_db-backup-2026-09-29.dump`. Keep until F4 is done.
- Backup before the rider auth migration: `C:\Users\HP\Documents\treeps_db-backup-2026-10-05.dump` (taken 2026-10-05; the tables were empty).
- Backup before the driver auth migration: `C:\Users\HP\Documents\treeps_db-backup-2026-10-07.dump` (taken 2026-10-07; `Rider`, `Device`, `RefreshToken` empty, `OtpSession` 11 rows).
- Restore only into a NEW empty database, never over an existing one.

## Migrate workflow
1. Edit the schema files in `prisma/` (models are split across files).
2. `npx prisma validate`
3. `npx prisma migrate dev --name <short_name>`
4. Read the generated `prisma/migrations/<timestamp>_<name>/migration.sql` before accepting it.
5. `npx prisma migrate status` should say the schema is up to date.
6. Commit `prisma/migrations/` including `migration_lock.toml`.

Migrating a non-dev database (production): TO DECIDE.

## Where things are
- Config: `prisma.config.ts`. Schema folder: `prisma/`. Migrations: `prisma/migrations/`.
