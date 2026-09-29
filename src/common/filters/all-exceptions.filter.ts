import { randomUUID } from 'node:crypto';
import { Catch, HttpException, Logger } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AppException, type ErrorDetail } from '../errors/app.exception.js';
import { ERROR_REGISTRY, type ErrorCode } from '../errors/error-registry.js';
import { REQUEST_ID_HEADER, getRequestId } from '../request-id/request-id.middleware.js';
import type { RequestWithId } from '../request-id/request-id.middleware.js';

const STATUS_TO_CODE: Partial<Record<number, ErrorCode>> = {
  400: 'INVALID_INPUT',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  429: 'RATE_LIMITED',
};

interface Classified {
  code: ErrorCode;
  field: string | null;
  details?: ErrorDetail[];
  originalStatus?: number;
}

interface ErrorPayload {
  code: ErrorCode;
  message: string;
  field: string | null;
  details?: ErrorDetail[];
}

// A non-Nest error counts as a client error only when it carries a 4xx status AND
// expose === true. body-parser errors (http-errors) do, for example 413 for an oversized
// body. An upstream provider's error (a map API rejecting our key, say) has no expose,
// so it stays a server failure and is never shown to a rider as their mistake.
function clientStatusOf(exception: unknown): number | undefined {
  if (typeof exception !== 'object' || exception === null) return undefined;
  const { status, statusCode, expose } = exception as {
    status?: unknown;
    statusCode?: unknown;
    expose?: unknown;
  };
  if (expose !== true) return undefined;
  const value = status ?? statusCode;
  return typeof value === 'number' && value >= 400 && value < 500 ? value : undefined;
}

function classify(exception: unknown): Classified {
  if (exception instanceof AppException) {
    return { code: exception.code, field: exception.field, details: exception.details };
  }
  const status =
    exception instanceof HttpException ? exception.getStatus() : clientStatusOf(exception);
  if (status === undefined) return { code: 'INTERNAL_ERROR', field: null };
  const mapped = STATUS_TO_CODE[status];
  if (mapped) return { code: mapped, field: null };
  if (status >= 400 && status < 500) {
    return { code: 'INVALID_INPUT', field: null, originalStatus: status };
  }
  return { code: 'INTERNAL_ERROR', field: null };
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();

    const requestId = getRequestId(req) ?? this.attachRequestId(req, res);
    const { code, field, details, originalStatus } = classify(exception);
    const { status, message } = ERROR_REGISTRY[code];

    this.log(exception, requestId, code, status, originalStatus);

    if (res.headersSent) {
      this.logger.warn(
        `requestId=${requestId} code=${code} status=${status} reply skipped: headers already sent`,
      );
      return;
    }

    const error: ErrorPayload = { code, message, field };
    if (code === 'INVALID_INPUT' && details !== undefined) {
      error.details = details;
    }
    res.status(status).json({ success: false, error, requestId });
  }

  private attachRequestId(req: Request, res: Response): string {
    const requestId = randomUUID();
    (req as RequestWithId).requestId = requestId;
    if (!res.headersSent) res.setHeader(REQUEST_ID_HEADER, requestId);
    return requestId;
  }

  // Never logs the request url, method, body or headers: they can carry phone numbers and tokens.
  private log(
    exception: unknown,
    requestId: string,
    code: ErrorCode,
    status: number,
    originalStatus: number | undefined,
  ): void {
    if (status < 500) {
      const note = originalStatus === undefined ? '' : ` originalStatus=${originalStatus}`;
      this.logger.warn(`requestId=${requestId} code=${code} status=${status}${note}`);
      return;
    }
    const detail = exception instanceof Error ? exception.message : String(exception);
    const stack = exception instanceof Error ? exception.stack : undefined;
    this.logger.error(`requestId=${requestId} code=${code} status=${status} error=${detail}`, stack);
  }
}
