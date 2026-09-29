# Progress Tracker

Last updated: 2026-09-29

| Stage | What | Status |
|---|---|---|
| F1 | Safety net: .gitignore, first commit, project rename | Done |
| F2 | Prisma 7 config fixed, dev DB emptied after backup, init migration applied | Done |
| F3 | Foundations | In progress |
| F3.0 | Documentation foundation | Done |
| F3.1 | Repo hygiene | Done |
| F3.2 | Response envelope, error-code registry and request id | In progress |
| F3.3 | Input and config validation | Not started |
| F3.4 | /v1 versioning only | Not started |
| F4 | Auth: real JWT, role guard, remove mock token | Not started |
| F5 | Rider, driver, ride and quote models | Not started |

## Backlog
- E2E test cannot find `supertest/types` (`test/app.e2e-spec.ts`). Fix in F3.3.
- Login code uses the removed `prisma.user` (`src/auth/auth.service.ts`). Fix in F4; do not patch before.
- Mock token security hole in `src/auth/firebase.service.ts`. **Do not deploy before F4.**
- Open decision for F4: Firebase phone OTP or own OTP with an SMS provider. Must be decided before F4 starts.
- `Rider` has no account status field (F5).
- Rename branch `master` to `main` before the first push.
- Keep the DB backup until F4 is done (see `runbooks/database.md`).
- Resolve the TO DECIDE items in `api/estimate.md` and `engines/fare-engine.md` before any fare math is built.
- Add a modifiers list and a discount line to the estimate breakdown (open question in `engines/fare-engine.md`).
- F3.3 config validation must check `DATABASE_URL` and `PORT` at startup.
- When code reads a new env variable, `.env.example` changes in the same commit.
- The `.claude` and `.windsurf` skill symlinks use absolute paths and break when the project folder is renamed. Reinstall the skills afterwards.
- Project folder is still `XCabServer` on disk (rename: optional, not decided).
