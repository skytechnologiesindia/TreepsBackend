import type { INestApplication } from '@nestjs/common';
import { AllExceptionsFilter } from './filters/all-exceptions.filter.js';
import { requestIdMiddleware } from './request-id/request-id.middleware.js';
import { ResponseInterceptor } from './interceptors/response.interceptor.js';
import { InputValidationPipe } from './validation/input-validation.pipe.js';

export function setupApp(app: INestApplication): void {
  app.use(requestIdMiddleware);
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new ResponseInterceptor());
  app.useGlobalPipes(new InputValidationPipe());
}
