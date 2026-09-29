import { Injectable } from '@nestjs/common';
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { ensureRequestId } from '../request-id/request-id.middleware.js';

export interface SuccessEnvelope<T> {
  success: true;
  data: T | null;
  requestId: string;
}

@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<T, SuccessEnvelope<T>> {
  intercept(context: ExecutionContext, next: CallHandler<T>): Observable<SuccessEnvelope<T>> {
    const http = context.switchToHttp();
    const requestId = ensureRequestId(http.getRequest<Request>(), http.getResponse<Response>());

    return next.handle().pipe(
      map((data) => ({ success: true as const, data: data ?? null, requestId })),
    );
  }
}
