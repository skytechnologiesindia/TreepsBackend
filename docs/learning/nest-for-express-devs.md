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

## Order a request travels through
Middleware, Guards, Interceptors (before), Pipes, Handler, Interceptors (after), Exception Filters (only on error).
