import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { AppException as TypeOnlyAppException } from '../errors/app.exception.js';
import { Latitude, Nested, Optional, Page, Required, ToInt } from './fields.js';
import {
  assertRouteInputs,
  findRouteInputProblems,
  RouteInputsError,
  ROUTE_INPUT_ALLOWLIST,
} from './route-inputs.js';

// ----- DTO classes (test-local limits, not project defaults)
class BodyDto {
  @Required(Latitude()) lat!: number;
}
class QueryDto {
  @ToInt() @Required(Page({ max: 50 })) page!: number;
}
class ParamsDto {
  @ToInt() @Required(Page({ max: 1_000_000 })) id!: number;
}
class NoRules {}
class Base {
  @Required(Latitude()) lat!: number;
}
class Inherited extends Base {}
interface LooseBody {
  name: string;
}

// ----- controllers used as inputs to the check
@Controller()
class GoodController {
  @Post('a') create(@Body() body: BodyDto) { return body; }
  @Get('b') list(@Query() query: QueryDto) { return query; }
  @Get('c/:id') one(@Param() params: ParamsDto) { return params; }
  @Get('d') plain() { return 1; }
  @Post('e') inherited(@Body() body: Inherited) { return body; }
}

@Controller()
class InlineController {
  @Post() create(@Body() body: { name: string }) { return body; }
}
@Controller()
class InterfaceController {
  @Post() create(@Body() body: LooseBody) { return body; }
}
@Controller()
class UnknownController {
  @Post() create(@Body() body: unknown) { return body; }
}
@Controller()
class TypeOnlyController {
  @Post() create(@Body() body: TypeOnlyAppException) { return body; } // "import type": recorded as Object
}
@Controller()
class PrimitiveController {
  @Get('q') q(@Query() q: string) { return q; }
  @Get('p') p(@Param() p: number) { return p; }
}
@Controller()
class NamedController {
  @Get('a/:id') a(@Param('id') id: string) { return id; }
  @Get('b') b(@Query('page') page: string) { return page; }
  @Post('c') c(@Body('x') x: string) { return x; }
}
@Controller()
class NoRulesController {
  @Post() create(@Body() body: NoRules) { return body; }
}
@Controller()
class NotARoute {
  helper(@Body() body: LooseBody) { return body; } // no route decorator: ignored
}
@Controller()
class ParentController {
  @Post('parent') create(@Body() body: { name: string }) { return body; }
}
@Controller()
class ChildController extends ParentController {}
@Controller()
class MissingMetadataController {
  @Post() create(@Body() body: BodyDto) { return body; }
}
// same handler name as the allowlisted one, on a differently named class
@Controller('auth')
class AuthController {
  @Post('login') login(@Body('idToken') idToken: string) { return idToken; }
}
@Controller('auth')
class OtherAuthController {
  @Post('login') login(@Body('idToken') idToken: string) { return idToken; }
}

// ----- DTO initializer check
class WithDefault {
  @Required(Latitude()) lat!: number;
  @ToInt() @Required(Page({ max: 50 })) page = 1;
}
class WithArrayDefault {
  @Required(Latitude()) lat!: number;
  tags: string[] = [];
}
class WithNullDefault {
  @Required(Latitude()) lat!: number;
  note: string | null = null;
}
class OnlyDeclared {
  @Required(Latitude()) lat!: number;
  @Optional(Latitude()) other?: number;
}
class Throws {
  @Required(Latitude()) lat!: number;
  constructor() {
    throw new Error('cannot construct');
  }
}
class InnerWithDefault {
  @Required(Latitude()) n = 1; // nested DTOs are out of scope for the check
}
class OuterDto {
  @Required(Nested(() => InnerWithDefault)) inner!: InnerWithDefault;
}
@Controller() class DefaultController { @Post() a(@Body() b: WithDefault) { return b; } }
@Controller() class ArrayDefaultController { @Post() a(@Body() b: WithArrayDefault) { return b; } }
@Controller() class NullDefaultController { @Post() a(@Body() b: WithNullDefault) { return b; } }
@Controller() class OnlyDeclaredController { @Post() a(@Body() b: OnlyDeclared) { return b; } }
@Controller() class ThrowsController { @Post() a(@Body() b: Throws) { return b; } }
@Controller() class NestedController { @Post() a(@Body() b: OuterDto) { return b; } }
@Controller() class QueryDefaultController { @Get() a(@Query() q: WithDefault) { return q; } }

const none = [] as const;

describe('findRouteInputProblems', () => {
  it('passes controllers whose body, query and path use DTO classes with rules', () => {
    expect(findRouteInputProblems([GoodController], none)).toEqual([]);
  });

  it('flags an inline object type as Object and names Controller.handler', () => {
    const [problem, ...rest] = findRouteInputProblems([InlineController], none);
    expect(rest).toEqual([]);
    expect(problem).toContain('InlineController.create');
    expect(problem).toContain('@Body() is typed as Object');
  });

  it.each([
    ['an interface', InterfaceController],
    ['unknown', UnknownController],
  ])('flags %s', (_name, controller) => {
    const [problem] = findRouteInputProblems([controller], none);
    expect(problem).toContain(`${controller.name}.create`);
    expect(problem).toContain('typed as Object');
  });

  it('flags a class imported with "import type" as Object (its metatype is lost)', () => {
    const [problem] = findRouteInputProblems([TypeOnlyController], none);
    expect(problem).toContain('TypeOnlyController.create');
    expect(problem).toContain('typed as Object');
    expect(problem).toContain('"import type"');
  });

  it('flags a whole-object query or path typed as a primitive', () => {
    const problems = findRouteInputProblems([PrimitiveController], none);
    expect(problems).toHaveLength(2);
    expect(problems.join('\n')).toContain('@Query() is typed as String');
    expect(problems.join('\n')).toContain('@Param() is typed as Number');
  });

  it('flags named extraction for body, query and path', () => {
    const problems = findRouteInputProblems([NamedController], none);
    expect(problems).toHaveLength(3);
    for (const kind of ['@Param()', '@Query()', '@Body()']) {
      expect(problems.join('\n')).toContain(`${kind} reads one named value`);
    }
  });

  it('flags a DTO class with zero rules, and accepts an inherited DTO whose parent has rules', () => {
    const [problem] = findRouteInputProblems([NoRulesController], none);
    expect(problem).toContain('DTO class NoRules has no validation rules');
    expect(findRouteInputProblems([GoodController], none)).toEqual([]); // includes `Inherited`
  });

  it('checks a handler inherited from a parent controller', () => {
    const [problem] = findRouteInputProblems([ChildController], none);
    expect(problem).toContain('ChildController.create');
    expect(problem).toContain('typed as Object');
  });

  it('ignores methods that are not routes', () => {
    expect(findRouteInputProblems([NotARoute], none)).toEqual([]);
  });

  it('flags a handler with no decorator metadata, so a build with metadata off cannot start', () => {
    expect(findRouteInputProblems([MissingMetadataController], none)).toEqual([]);
    Reflect.deleteMetadata('design:paramtypes', MissingMetadataController.prototype, 'create');
    const [problem] = findRouteInputProblems([MissingMetadataController], none);
    expect(problem).toContain('MissingMetadataController.create');
    expect(problem).toContain('no decorator metadata');
    expect(problem).toContain('emitDecoratorMetadata');
  });

  describe('the allowlist', () => {
    it('skips the allowlisted controller and handler by name', () => {
      expect(findRouteInputProblems([AuthController])).toEqual([]);
    });

    it('does not skip the same handler on a differently named class', () => {
      const problems = findRouteInputProblems([OtherAuthController]);
      expect(problems.join('\n')).toContain('OtherAuthController.login');
      expect(problems.join('\n')).toContain('Allowlist entry AuthController.login');
    });

    it('reports an allowlist entry that matches no route as stale', () => {
      const [problem] = findRouteInputProblems([GoodController], [
        { controller: 'Gone', handler: 'nothing', reason: 'remove in F4' },
      ]);
      expect(problem).toContain('Allowlist entry Gone.nothing (remove in F4) matches no route. Remove it.');
    });

    it('has exactly one production entry', () => {
      expect(ROUTE_INPUT_ALLOWLIST).toEqual([
        { controller: 'AuthController', handler: 'login', reason: 'remove in F4' },
      ]);
    });
  });

  describe('the DTO initializer check (top-level route DTOs)', () => {
    it('flags a DTO with a default value such as page = 1', () => {
      const [problem] = findRouteInputProblems([DefaultController], none);
      expect(problem).toContain('DefaultController.a');
      expect(problem).toContain('WithDefault sets a default value on page');
      expect(problem).toContain('silent default');
    });

    it('flags array and null defaults too (anything not undefined)', () => {
      expect(findRouteInputProblems([ArrayDefaultController], none)[0]).toContain('on tags');
      expect(findRouteInputProblems([NullDefaultController], none)[0]).toContain('on note');
    });

    it('also checks a query DTO', () => {
      expect(findRouteInputProblems([QueryDefaultController], none)[0]).toContain('@Query() DTO class WithDefault');
    });

    it('does NOT flag declared fields that are undefined (lat!: number, other?: number)', () => {
      expect(findRouteInputProblems([OnlyDeclaredController], none)).toEqual([]);
    });

    it('flags a DTO whose constructor throws', () => {
      const [problem] = findRouteInputProblems([ThrowsController], none);
      expect(problem).toContain('ThrowsController.a');
      expect(problem).toContain('DTO class Throws throws when constructed without arguments');
      expect(problem).not.toContain('cannot construct'); // the error text is never printed
    });

    it('does not look inside nested DTOs (known limit, on the backlog)', () => {
      expect(findRouteInputProblems([NestedController], none)).toEqual([]);
    });
  });
});

describe('assertRouteInputs on a Nest app', () => {
  it('throws one error that lists every problem, with Controller.handler and the rule references', async () => {
    // AuthController is included so the production allowlist entry is not reported as stale.
    const moduleRef = await Test.createTestingModule({
      controllers: [InterfaceController, NamedController, AuthController],
    }).compile();
    const app = moduleRef.createNestApplication();
    let message = '';
    try {
      assertRouteInputs(app);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('Route input check failed');
    expect(message).toContain('docs/standards/input-validation.md');
    expect(message).toContain('InterfaceController.create');
    expect(message).toContain('NamedController.a');
    expect(message.split('\n').filter((l) => l.startsWith('  - '))).toHaveLength(4);
    await moduleRef.close();
  });

  it('throws a RouteInputsError, so the startup printer may show its message', async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [InlineController] }).compile();
    const app = moduleRef.createNestApplication();
    let error: unknown;
    try {
      assertRouteInputs(app);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(RouteInputsError);
    expect((error as Error).name).toBe('RouteInputsError');
    await moduleRef.close();
  });

  it('passes for an app whose routes use DTO classes, plus the one allowlisted login route', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [GoodController, AuthController],
    }).compile();
    const app = moduleRef.createNestApplication();
    expect(() => assertRouteInputs(app)).not.toThrow();
    await moduleRef.close();
  });

  it('reports the production allowlist entry as stale when no such route exists', async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [GoodController] }).compile();
    const app = moduleRef.createNestApplication();
    expect(() => assertRouteInputs(app)).toThrow(/Allowlist entry AuthController\.login/);
    await moduleRef.close();
  });

  it('does not start work that touches request data: the message holds only names and types', async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [InlineController] }).compile();
    const app = moduleRef.createNestApplication();
    expect(() => assertRouteInputs(app)).toThrow(/InlineController\.create: @Body\(\) is typed as Object/);
    await moduleRef.close();
  });
});
