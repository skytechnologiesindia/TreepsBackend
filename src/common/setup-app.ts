import type { INestApplication } from '@nestjs/common';
import { enableApiVersioning } from './api-version.js';
import { AllExceptionsFilter } from './filters/all-exceptions.filter.js';
import { requestIdMiddleware } from './request-id/request-id.middleware.js';
import { IstTwinInterceptor } from './interceptors/ist-twin.interceptor.js';
import { ResponseInterceptor } from './interceptors/response.interceptor.js';
import { InputValidationPipe } from './validation/input-validation.pipe.js';

export function setupApp(app: INestApplication): void {
  enableApiVersioning(app);
  app.use(requestIdMiddleware);
  app.useGlobalFilters(new AllExceptionsFilter());
  // Order matters: the first one is the outer one. The wrapper is outer, so the IST twins are added
  // to what the handler returned before it is wrapped.
  app.useGlobalInterceptors(new ResponseInterceptor(), new IstTwinInterceptor());
  app.useGlobalPipes(new InputValidationPipe());
}
