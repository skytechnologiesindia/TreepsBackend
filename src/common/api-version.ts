import { VersioningType } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';

// The default version of every route. Controllers never write it in their path: the default
// version adds the "/v1" prefix, so a written "v1/rides" would be served at /v1/v1/rides.
export const API_VERSION = '1';

// Nest "URI versioning" is the Nest way of mounting routers at /v1: an unannotated controller is
// version API_VERSION, @Version('2') puts a route at /v2, and VERSION_NEUTRAL (reserved for
// /health) has no prefix. A path with no version, or with an unknown one, is a normal NOT_FOUND.
export function enableApiVersioning(app: INestApplication): void {
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: API_VERSION });
}
