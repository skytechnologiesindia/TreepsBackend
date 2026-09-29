import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { setupApp } from './common/setup-app.js';
import { assertRouteInputs } from './common/validation/route-inputs.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  setupApp(app);
  assertRouteInputs(app);
  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
