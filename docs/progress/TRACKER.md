# Progress Tracker

Last updated: 2026-09-29

| Stage | What | Status |
|---|---|---|
| F1 | Safety net: .gitignore, first commit, project rename | Done |
| F2 | Prisma 7 config fixed, dev DB emptied after backup, init migration applied | Done |
| F3 | Foundations | In progress |
| F3.0 | Documentation foundation | In progress |
| F3.1 | Repo hygiene | Not started |
| F3.2 | Response envelope and error-code registry | Not started |
| F3.3 | Input and config validation | Not started |
| F3.4 | /v1 prefix and request ID | Not started |
| F4 | Auth: real JWT, role guard, remove mock token | Not started |
| F5 | Rider, driver, ride and quote models | Not started |

## Backlog
- E2E test cannot find `supertest/types` (`test/app.e2e-spec.ts`).
- Login code uses the removed `prisma.user` (`src/auth/auth.service.ts`). Fix in F4; do not patch before.
- Mock token security hole in `src/auth/firebase.service.ts`. **Do not deploy before F4.**
- `Rider` has no account status field (F5).
- Rename branch `master` to `main` before the first push.
- Keep the DB backup until F4 is done (see `runbooks/database.md`).
