# NestJS and Prisma for Express/Mongoose Developers

Append new terms at the bottom as they come up.

| Express / Mongoose | NestJS / Prisma | Note |
|---|---|---|
| Route file (`router.get(...)`) | **Controller** | Maps HTTP routes to methods |
| Logic inside route handlers | **Service** | Controller stays thin; service holds the logic |
| Middleware for auth checks | **Guard** | Decides whether a request may proceed |
| Middleware for validating/transforming input | **Pipe** | Runs on inputs before the handler |
| Middleware for wrapping responses, logging | **Interceptor** | Runs before and after the handler |
| Error-handling middleware | **Exception Filter** | Turns thrown errors into responses |
| `req.body` checks by hand | **DTO** (class + class-validator) | A class listing allowed fields and rules |
| Mongoose schema and model | **Prisma model** (`.prisma` files) | Generates a typed client |
| `Model.find()` | `prisma.<model>.findMany()` | |
| `.populate()` | `include` | |
| No migrations (schemaless) | **Migrations are mandatory** | Every schema change is a migration file in `prisma/migrations/` |
| `require()` and `app.use(...)` wiring | **Modules** and dependency injection | A module declares its controllers and providers |
| `app.js` | `main.ts` | Creates the app and starts it |
| `process.env` | **ConfigModule** | Loads `.env` |
| `mongoose.connect()` | **PrismaService** (extends PrismaClient) | Connects on module start |
| Joi `.required()` / `.optional()` | `Required(type)` / `Optional(type)` (`src/common/validation/fields.ts`) | Wrap a shared field type on a DTO property: required, or checked only when sent |
| Joi `.number().min(-90).max(90)` | `Latitude()`, `Longitude()` | JSON numbers within the degree range |
| Regex check on a phone string | `Phone({ minDigits, maxDigits })` | E.164 string: `+` then digits |
| Number field holding rupees | `Money({ max })` | Integer paise, 0 or more |
| `Number(req.query.page)` by hand | `Page({ max })`, `PageSize({ max })`, `ToInt()` | Integer paging values; `ToInt()` converts a query string strictly |
| `new Date(str)` guessing zones | `UtcDate({ min, max })` | UTC text with `Z`; limits are functions |
| `uuid.validate(str)` | `Uuid({ versions })` | UUID string |
| `Joi.string().min().max()` | `Text({ min, max })` | Length counted in code points |
| `Joi.valid('A','B')` / a Mongoose `enum` | `OneOf(values)` | The value must be one of the listed strings |
| Joi `.object(schema)` / a Mongoose sub-document | `Nested(() => Dto)` | An object checked against another DTO class |
| Joi `.array().items(schema).min().max()` / an array of sub-documents | `NestedList(() => Dto, { min, max })` | A list of objects, each checked against a DTO class, with a size limit |

## Order a request travels through
Middleware, Guards, Interceptors (before), Pipes, Handler, Interceptors (after), Exception Filters (only on error).
