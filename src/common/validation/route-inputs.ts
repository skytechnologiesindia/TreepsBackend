import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import {
  PARAMTYPES_METADATA,
  PATH_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants.js';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum.js';
import { ModulesContainer } from '@nestjs/core';
import { getMetadataStorage } from 'class-validator';

export interface RouteInputAllowance {
  controller: string;
  handler: string;
  reason: string;
}

// Routes that break the rules today. Each entry says when it must be removed.
export const ROUTE_INPUT_ALLOWLIST: readonly RouteInputAllowance[] = [
  { controller: 'AuthController', handler: 'login', reason: 'remove in F4' },
];

const CHECKED: Readonly<Record<number, string>> = {
  [RouteParamtypes.BODY]: '@Body()',
  [RouteParamtypes.QUERY]: '@Query()',
  [RouteParamtypes.PARAM]: '@Param()',
};

// An interface, an inline type, unknown, a primitive, or a class imported with
// "import type" is recorded by the compiler as one of these, and Nest then skips validation.
const NOT_A_DTO = new Set<unknown>([
  Object,
  String,
  Number,
  Boolean,
  Array,
  Date,
  Buffer,
  Function,
  Symbol,
  BigInt,
  Promise,
]);

type DtoClass = new () => object;

function handlersOf(controller: Function): Array<{ name: string; owner: object }> {
  const found: Array<{ name: string; owner: object }> = [];
  for (let p = controller.prototype; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
    for (const name of Object.getOwnPropertyNames(p)) {
      if (name === 'constructor' || typeof p[name] !== 'function') continue;
      if (Reflect.getMetadata(PATH_METADATA, p[name]) === undefined) continue; // not a route
      if (!found.some((f) => f.name === name)) found.push({ name, owner: p });
    }
  }
  return found;
}

// A value set inside a DTO is a silent default (input-validation.md rule 3): it would satisfy
// "required" without the client sending anything. Declared fields such as `lat!: number` are
// undefined and are fine. Only the top-level route DTO is checked; nested DTOs are not.
function initializerProblem(where: string, kind: string, dto: DtoClass): string | undefined {
  let instance: object;
  try {
    instance = new dto();
  } catch {
    return `${where}: ${kind} DTO class ${dto.name} throws when constructed without arguments. A DTO must be constructible without arguments.`;
  }
  const preset = Object.keys(instance).filter(
    (key) => (instance as Record<string, unknown>)[key] !== undefined,
  );
  if (preset.length > 0) {
    return `${where}: ${kind} DTO class ${dto.name} sets a default value on ${preset.join(', ')}. That is a silent default (input-validation.md rule 3). Document the default in the API doc and apply it in the service, not in the DTO.`;
  }
  return undefined;
}

export function findRouteInputProblems(
  controllers: readonly Function[],
  allowlist: readonly RouteInputAllowance[] = ROUTE_INPUT_ALLOWLIST,
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const controller of controllers) {
    for (const { name, owner } of handlersOf(controller)) {
      const where = `${controller.name}.${name}`;
      seen.add(where);
      if (allowlist.some((a) => a.controller === controller.name && a.handler === name)) continue;
      const args = (Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, name) ?? {}) as Record<
        string,
        { index: number; data?: unknown }
      >;
      const types = Reflect.getMetadata(PARAMTYPES_METADATA, owner, name) as unknown[] | undefined;
      for (const [key, arg] of Object.entries(args)) {
        const kind = CHECKED[Number(key.split(':')[0])];
        if (kind === undefined) continue;
        if (arg.data !== undefined) {
          problems.push(
            `${where}: ${kind} reads one named value, which skips validation. Read the whole object through a DTO class.`,
          );
          continue;
        }
        const metatype = types?.[arg.index];
        if (metatype === undefined) {
          problems.push(`${where}: no decorator metadata for ${kind} (is emitDecoratorMetadata on?).`);
        } else if (typeof metatype !== 'function' || NOT_A_DTO.has(metatype)) {
          const typed = typeof metatype === 'function' ? metatype.name : typeof metatype;
          problems.push(
            `${where}: ${kind} is typed as ${typed}, which has no validation rules. Use a DTO class (not an interface, inline type, unknown, or a class imported with "import type").`,
          );
        } else if (
          getMetadataStorage().getTargetValidationMetadatas(metatype as DtoClass, '', true, false)
            .length === 0
        ) {
          problems.push(`${where}: ${kind} DTO class ${metatype.name} has no validation rules.`);
        } else {
          const problem = initializerProblem(where, kind, metatype as DtoClass);
          if (problem !== undefined) problems.push(problem);
        }
      }
    }
  }
  for (const a of allowlist) {
    if (!seen.has(`${a.controller}.${a.handler}`)) {
      problems.push(`Allowlist entry ${a.controller}.${a.handler} (${a.reason}) matches no route. Remove it.`);
    }
  }
  return problems;
}

// The message holds only controller names, handler names and rule references, never request
// data, so it is safe to print at startup (see src/config/startup-failure.ts).
export class RouteInputsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RouteInputsError';
  }
}

export function controllersOf(app: INestApplication): Function[] {
  const controllers: Function[] = [];
  for (const module of app.get(ModulesContainer).values()) {
    for (const wrapper of module.controllers.values()) {
      if (wrapper.metatype) controllers.push(wrapper.metatype);
    }
  }
  return controllers;
}

// Call this after the modules are created and before app.listen(). At that point
// PrismaService.onModuleInit has not run, so a failure here happens before any database
// connection. It throws one error that lists every problem, and the process exits.
export function assertRouteInputs(app: INestApplication): void {
  const problems = findRouteInputProblems(controllersOf(app));
  if (problems.length > 0) {
    throw new RouteInputsError(
      `Route input check failed (docs/standards/input-validation.md, rules 1, 3 and 5):\n${problems
        .map((p) => `  - ${p}`)
        .join('\n')}`,
    );
  }
}
