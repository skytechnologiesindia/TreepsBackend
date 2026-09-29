import { ValidationPipe, type ArgumentMetadata } from '@nestjs/common';
import { AppException } from '../errors/app.exception.js';
import { toAppException } from './to-app-exception.js';

// Rule 11: a body is unusable when it is missing, null, an array, or a bare value.
export function isUsableBody(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class InputValidationPipe extends ValidationPipe {
  constructor() {
    super({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
      transformOptions: { enableImplicitConversion: false },
      validationError: { target: false, value: false },
      exceptionFactory: (errors) => toAppException(errors),
    });
  }

  override async transform(value: unknown, metadata: ArgumentMetadata): Promise<unknown> {
    // Whole-body parameters only; a named one (@Body('x')) is banned by rule 5.
    if (metadata.type === 'body' && metadata.data === undefined && !isUsableBody(value)) {
      throw new AppException('INVALID_INPUT');
    }
    return super.transform(value, metadata);
  }
}
