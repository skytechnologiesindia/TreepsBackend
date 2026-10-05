# How a request flows through Treeps

**At a glance:** request, then middleware, routing, guard, pipe, handler, interceptor, reply.
Any error, at any step, goes to the exception filter.
The filter always answers in the standard error shape, so the apps parse every reply the same way.

For an Express developer new to NestJS. Terms are in [nest-for-express-devs.md](nest-for-express-devs.md). Every path below is a real file in this repo, and every reply was captured by running the real app (see the end).

**The request:** `POST /v1/demo` with `{"name":"Asha","amount":5000}`. The captured runs use a throwaway controller wired by the same `setupApp` the tests use. The real `POST /v1/rides/estimate` (L0) is quoted where it applies.

## Before any request: startup
`src/main.ts` runs in this order: create the app, `setupApp`, `assertRouteInputs`, the database check, `listen`. A failed check exits with code 1 and nothing is served.

## The path of one request
1. **Middleware** (Express: `app.use(fn)`). `requestIdMiddleware` in `src/common/request-id/request-id.middleware.ts` makes a UUID and sets the `X-Request-Id` header. It is registered by `setupApp` (`src/common/setup-app.ts`), so it also runs for requests that fail later.
2. **Body parser** (Express: `express.json()`). Nest registers Express's own JSON parser. Malformed JSON fails here, before any Nest code, and goes to step 10.
3. **Versioning and routing** (Express: `app.use('/v1', router)`). `enableApiVersioning` in `src/common/api-version.ts` gives every controller the default version `1`, so `@Controller('demo')` is served at `/v1/demo`. `/demo`, `/v2/demo` and `/nope` match nothing and become NOT_FOUND.
4. **Guards** (Express: an auth middleware that decides yes or no). A guard is told which controller class and handler method will run (`context.getClass()` and `context.getHandler()`, checked with a throwaway guard) and lets the request in or throws. None exist yet (F4).
5. **Interceptor, before part** (Express: middleware wrapped around the handler). `ResponseInterceptor` in `src/common/interceptors/response.interceptor.ts` makes sure a request id exists. A route can add its own interceptor.
6. **Validation pipe** (Express: Joi or celebrate on `req.body`). `InputValidationPipe` in `src/common/validation/input-validation.pipe.ts` turns the body into the DTO class (Mongoose: a schema) and checks it. It refuses a missing or non-object body, unknown fields, and bad values, and builds the error in `to-app-exception.ts`. The DTO fields use the shared types in `src/common/validation/fields.ts`.
7. **Handler** (Express: the route function). The controller method receives the checked DTO and calls a service, which uses `PrismaService` in `src/prisma/` (Mongoose: the model). It returns plain data.
8. **Interceptor, after part.** `ResponseInterceptor` wraps the returned value as `{ success: true, data, requestId }`.
9. **Reply.** The status is Nest's default (201 for POST).
10. **On an error** (Express: an error middleware `(err, req, res, next)`). An exception thrown at any step from 2 to 8 goes to the exception filter, `AllExceptionsFilter` in `src/common/filters/all-exceptions.filter.ts`. It turns the error into `{ success: false, error: { code, message, field }, requestId }` using the registry in `src/common/errors/error-registry.ts`. An error that is not an `AppException` becomes INTERNAL_ERROR and its text is only logged, never sent.

## What the running app returned
Order of the steps, from a trace of the demo route: `guard > interceptor before > pipe > handler > interceptor after`. Order of the Express stack: `requestIdMiddleware -> jsonParser -> urlencodedParser -> Nest routes`.

| Request | Status | Reply (shortened) |
|---|---|---|
| `POST /v1/demo` valid | 201 | `{"success":true,"data":{"name":"Asha","amount":5000},"requestId":"575d3ef3-…"}` |
| missing `amount`, extra field | 400 | `error.code` INVALID_INPUT, `field` "amount", `details` `[{amount REQUIRED},{extra UNKNOWN_FIELD}]`. The handler never ran. |
| handler throws `AppException('OUT_OF_SERVICE_AREA')` | 422 | `"message":"We don't serve this area yet."` |
| handler throws `Error('secret-db-password-xyz')` | 500 | INTERNAL_ERROR with the fixed message; the secret is not in the reply |
| malformed JSON, or no body | 400 | INVALID_INPUT, `field` null |
| `POST /demo` (no `/v1`) | 404 | NOT_FOUND |
| real `POST /v1/rides/estimate` with `{}` | 400 | INVALID_INPUT |

Every reply, including the failures, carried an `X-Request-Id` header equal to the body's `requestId`.

## How to add an API (checklist)
1. **Doc first.** Copy `docs/templates/api-doc-template.md` to `docs/api/<name>.md`, fill it in, get it approved. No code before that (the docs-first rule in `CLAUDE.md`).
2. **Files.** Under `src/modules/<domain>/`: `<domain>.module.ts`, `<domain>.controller.ts`, `<domain>.service.ts`, `dto/<name>.dto.ts`. Import the module in `src/app.module.ts`. The `src/modules/` folder is created with the first real API.
3. **DTO.** One class per body, query or params. Each field uses `Required(...)` or `Optional(...)` with a shared type: `Latitude`, `Longitude`, `Phone`, `Money`, `Page`, `PageSize`, `UtcDate`, `Uuid`, `Text`, `OneOf`, `Nested`, `NestedList` (with `ToInt` for numbers in a query). Rules: `docs/standards/input-validation.md`. Never accept a derived value (price, distance, status).
4. **Controller.** `@Controller('rides')`, never `@Controller('v1/rides')` (it would serve `/v1/v1/rides`). Take the whole object: `@Body() dto: EstimateDto`.
5. **Errors.** `throw new AppException('CODE', { field })`. A new code goes in `error-registry.ts` and the table in `docs/standards/response-format.md` in the same change.
6. **Tests.** The ones listed in the API doc. Build the app with `setupApp` and use `versionedBaseUrl` from `src/common/testing/base-url.ts`.
7. **Docs.** API doc changelog, `TRACKER.md`, and `DECISIONS.md` if you decided something.

**Checks that refuse to run if a rule is broken:**
- `assertRouteInputs` (`src/common/validation/route-inputs.ts`): the server will not start if any `@Body()`, `@Query()` or `@Param()` lacks a DTO class with rules. `real-routes.spec.ts` runs the same check in CI.
- `banned-patterns.spec.ts`: fails the build on `Parse*Pipe`, named `@Body('x')`, `@Query('x')`, `@Param('x')`, `@Req`, `@Res`, `@Headers`, and a version written in a `@Controller` path.
- Startup configuration (`src/config/`): a bad `DATABASE_URL`, `PORT` or `NODE_ENV`, or an unreachable database, stops the server.

## Deliberately not done yet
- **Authentication (F4).** Until F4 no route has authentication (the L0 estimate route is open, decision 81); do not deploy. The old Firebase login and its mock token were removed on 2026-10-05 (decision 146).
- **Rate limiting.** No rate limiter exists, although RATE_LIMITED is in the registry and every API needs one. It comes with F4 because it needs the user id.
- **The models (F5).** Rider, driver, ride and quote tables and their APIs.
- **An access log.** The filter logs only the request id, code and status, never URLs or bodies.
- **`/health`.** It will be the one version-neutral route.
- Everything else that is open is in the backlog of `docs/progress/TRACKER.md`.
