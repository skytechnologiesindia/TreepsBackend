import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { setupApp } from './common/setup-app.js';
import { assertRouteInputs } from './common/validation/route-inputs.js';
import { assertDatabaseReachable } from './config/database-check.js';
import type { ValidatedEnv } from './config/env.validation.js';
import { refuseToStart } from './config/startup-failure.js';

// A refused start exits with code 1 and prints only a safe line (see startup-failure.ts). This does
// not depend on Node's default unhandled-rejection behavior. An invalid environment is a rejection
// that happens outside bootstrap() (when the module is defined), so it is handled here too.
process.on('unhandledRejection', (reason) => refuseToStart(reason));

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  setupApp(app);
  assertRouteInputs(app);
  const config = app.get<ConfigService<ValidatedEnv, true>>(ConfigService);
  await assertDatabaseReachable(config.get('DATABASE_URL', { infer: true }));
  await app.listen(config.get('PORT', { infer: true }));
}
await bootstrap().catch((error) => refuseToStart(error));
