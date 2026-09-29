import type { INestApplication } from '@nestjs/common';
import { requestIdMiddleware } from './request-id/request-id.middleware.js';
import { ResponseInterceptor } from './interceptors/response.interceptor.js';

export function setupApp(app: INestApplication): void {
  app.use(requestIdMiddleware);
  app.useGlobalInterceptors(new ResponseInterceptor());
}
