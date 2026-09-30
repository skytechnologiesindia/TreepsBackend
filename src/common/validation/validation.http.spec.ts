import {
  Body,
  Controller,
  Get,
  Injectable,
  Logger,
  Param,
  Post,
  Query,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { CanActivate, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { IsString, Matches } from 'class-validator';
import { setupApp } from '../setup-app.js';
import { versionedBaseUrl } from '../testing/base-url.js';
import {
  Latitude,
  Longitude,
  Nested,
  NestedList,
  Optional,
  Page,
  PageSize,
  Required,
  Text,
  ToInt,
} from './fields.js';

// The limits below are test-local values, not project defaults.
class PointDto {
  @Required(Latitude()) lat!: number;
  @Required(Longitude()) lng!: number;
}
class TripBody {
  @Required(Latitude()) lat!: number;
  @Required(Longitude()) lng!: number;
  @Optional(Text({ min: 1, max: 20 })) note?: string;
  @Required(Nested(() => PointDto)) pickup!: PointDto;
  @Required(NestedList(() => PointDto, { min: 0, max: 2 })) stops!: PointDto[];
}
class AllOptionalBody {
  @Optional(Latitude()) lat?: number;
}
class ListQuery {
  @ToInt() @Required(Page({ max: 50 })) page!: number;
  @ToInt() @Optional(PageSize({ max: 20 })) pageSize?: number;
}
class IdParams {
  @ToInt() @Required(Page({ max: 1_000_000 })) id!: number;
}
class LeakBody {
  @IsString({ message: 'SECRET-CLASS-VALIDATOR-TEXT' })
  @Matches(/^x$/, { message: 'SECRET-PATTERN-TEXT' })
  code!: string;
}
interface LooseBody {
  name: string;
}

@Injectable()
class DenyAll implements CanActivate {
  canActivate(): boolean {
    throw new UnauthorizedException();
  }
}

const reached = vi.fn();

@Controller()
class TestController {
  @Post('trips')
  create(@Body() body: TripBody) {
    reached('create', body);
    return { lat: body.lat };
  }

  @Post('optional')
  optional(@Body() body: AllOptionalBody) {
    reached('optional', body);
    return { ok: true };
  }

  @Get('trips')
  list(@Query() query: ListQuery) {
    reached('list', query);
    return { page: query.page, type: typeof query.page, pageSize: query.pageSize ?? null };
  }

  @Get('trips/:id')
  one(@Param() params: IdParams) {
    reached('one', params);
    return { id: params.id, type: typeof params.id };
  }

  @Post('leak')
  leak(@Body() body: LeakBody) {
    reached('leak', body);
    return {};
  }

  @Post('loose')
  loose(@Body() body: LooseBody) {
    reached('loose', body);
    return { got: body };
  }

  @Post('guarded')
  @UseGuards(DenyAll)
  guarded(@Body() body: TripBody) {
    reached('guarded', body);
    return {};
  }
}

const GOOD = { lat: 0, lng: 0, pickup: { lat: 0, lng: 0 }, stops: [] };
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('input validation over real HTTP', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const moduleRef = await Test.createTestingModule({ controllers: [TestController] }).compile();
    app = moduleRef.createNestApplication();
    setupApp(app);
    await app.listen(0, '127.0.0.1');
    baseUrl = versionedBaseUrl(app);
  });

  beforeEach(() => {
    reached.mockClear();
  });

  afterAll(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  const send = async (path: string, init?: RequestInit) => {
    const res = await fetch(baseUrl + path, init);
    return { res, body: await res.json() };
  };
  const post = (path: string, payload: unknown) =>
    send(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  const rawPost = (path: string, body: string | undefined, contentType?: string) =>
    send(path, { method: 'POST', headers: contentType ? { 'Content-Type': contentType } : {}, body });
  const pairs = (body: any) => (body.error.details ?? []).map((d: any) => [d.field, d.reason]);
  const expectInvalid = (res: Response, body: any) => {
    expect(res.status).toBe(400);
    expect(Object.keys(body)).toEqual(['success', 'error', 'requestId']);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('INVALID_INPUT');
    expect(body.error.message).toBe('Please check your input.');
    expect(body.requestId).toMatch(UUID_V4);
    expect(res.headers.get('x-request-id')).toBe(body.requestId);
  };

  it('CANARY: a DTO route rejects bad input and the handler is never reached', async () => {
    const { res, body } = await post('/trips', { ...GOOD, lat: 'not a number' });
    expectInvalid(res, body);
    expect(pairs(body)).toEqual([['lat', 'WRONG_TYPE']]);
    // If this fails, decorator metadata is not reaching Nest and NO route is validated.
    expect(reached).not.toHaveBeenCalled();
  });

  it('accepts a valid body and hands the handler a DTO instance', async () => {
    const { res, body } = await post('/trips', GOOD);
    expect(res.status).toBe(201);
    expect(body.success).toBe(true);
    expect(reached).toHaveBeenCalledWith('create', expect.any(TripBody));
  });

  it('an unknown body field gives UNKNOWN_FIELD and names it', async () => {
    const { res, body } = await post('/trips', { ...GOOD, price: 100 });
    expectInvalid(res, body);
    expect(pairs(body)).toEqual([['price', 'UNKNOWN_FIELD']]);
    expect(body.error.field).toBe('price');
    expect(reached).not.toHaveBeenCalled();
  });

  it('a string where a number is expected is rejected with no coercion', async () => {
    const { res, body } = await post('/trips', { ...GOOD, lat: '12.5' });
    expectInvalid(res, body);
    expect(pairs(body)).toEqual([['lat', 'WRONG_TYPE']]);
    expect(reached).not.toHaveBeenCalled();
  });

  it('a missing required field is REQUIRED, not WRONG_TYPE', async () => {
    const { lat: _omitted, ...withoutLat } = GOOD;
    const { body } = await post('/trips', withoutLat);
    expect(pairs(body)).toEqual([['lat', 'REQUIRED']]);
  });

  it('three bad fields all appear, sorted, and field is the first real one', async () => {
    const { body } = await post('/trips', { ...GOOD, note: '', lng: 999, lat: 'x' });
    expect(pairs(body)).toEqual([
      ['lat', 'WRONG_TYPE'],
      ['lng', 'OUT_OF_RANGE'],
      ['note', 'REQUIRED'],
    ]);
    expect(body.error.field).toBe('lat');
  });

  it('nested objects and list items are named with dot paths', async () => {
    const payload = {
      ...GOOD,
      pickup: { lat: 'x', lng: 0, foo: 1 },
      stops: [
        { lat: 0, lng: 0 },
        { lat: 200, lng: 0, bar: 2 },
      ],
    };
    const { body } = await post('/trips', payload);
    expect(pairs(body)).toEqual([
      ['pickup.foo', 'UNKNOWN_FIELD'],
      ['pickup.lat', 'WRONG_TYPE'],
      ['stops.1.bar', 'UNKNOWN_FIELD'],
      ['stops.1.lat', 'OUT_OF_RANGE'],
    ]);
    expect(body.error.field).toBe('pickup.foo');
  });

  it('an unsafe unknown name collapses into $unknown and field skips it', async () => {
    const { body } = await post('/trips', { ...GOOD, 'bad key!': 1 });
    expect(pairs(body)).toEqual([['$unknown', 'UNKNOWN_FIELD']]);
    expect(body.error.field).toBeNull();
    expect(JSON.stringify(body)).not.toContain('bad key');
  });

  describe('query and path values', () => {
    it('a query value works only through ToInt, and the handler gets a number', async () => {
      const { res, body } = await send('/trips?page=2');
      expect(res.status).toBe(200);
      expect(body.data).toEqual({ page: 2, type: 'number', pageSize: null });
    });

    it.each(['abc', '0x10', '007', '', '2.5', '-1'])('page=%j gives exactly WRONG_TYPE', async (page) => {
      const { res, body } = await send(`/trips?page=${encodeURIComponent(page)}`);
      expectInvalid(res, body);
      expect(pairs(body)).toEqual([['page', 'WRONG_TYPE']]);
      expect(reached).not.toHaveBeenCalled();
    });

    it.each(['0', '51'])('page=%s gives exactly OUT_OF_RANGE', async (page) => {
      const { res, body } = await send(`/trips?page=${page}`);
      expectInvalid(res, body);
      expect(pairs(body)).toEqual([['page', 'OUT_OF_RANGE']]);
      expect(reached).not.toHaveBeenCalled();
    });

    it('rejects a repeated parameter (an array) as WRONG_TYPE', async () => {
      const { body } = await send('/trips?page=1&page=2');
      expect(pairs(body)).toEqual([['page', 'WRONG_TYPE']]);
    });

    it('an unknown query parameter is rejected like any unknown field', async () => {
      const { res, body } = await send('/trips?page=1&utm=x');
      expectInvalid(res, body);
      expect(pairs(body)).toEqual([['utm', 'UNKNOWN_FIELD']]);
    });

    it('a bracketed query key collapses into $unknown', async () => {
      const { body } = await send('/trips?page=1&a[b]=1');
      expect(pairs(body)).toEqual([['$unknown', 'UNKNOWN_FIELD']]);
    });

    it('a path parameter goes through a DTO: 42 passes, abc and 007 fail', async () => {
      expect((await send('/trips/42')).body.data).toEqual({ id: 42, type: 'number' });
      for (const id of ['abc', '007']) {
        const { res, body } = await send(`/trips/${id}`);
        expectInvalid(res, body);
        expect(pairs(body)).toEqual([['id', 'WRONG_TYPE']]);
      }
    });
  });

  it('never puts class-validator text or the submitted value in the reply', async () => {
    const { body } = await post('/leak', {
      code: 'zzz-submitted-value',
      extra: 'secret-submitted-value',
    });
    expect(pairs(body)).toEqual([
      ['code', 'INVALID_VALUE'],
      ['extra', 'UNKNOWN_FIELD'],
    ]);
    const text = JSON.stringify(body);
    for (const forbidden of [
      'SECRET-CLASS-VALIDATOR-TEXT',
      'SECRET-PATTERN-TEXT',
      'zzz-submitted-value',
      'secret-submitted-value',
      'must be',
      'must match',
    ]) {
      expect(text).not.toContain(forbidden);
    }
  });

  describe('odd bodies (rule 11)', () => {
    const unusable: Array<[string, () => Promise<{ res: Response; body: any }>]> = [
      ['no body', () => rawPost('/optional', undefined)],
      ['text/plain', () => rawPost('/optional', 'hello', 'text/plain')],
      ['an array', () => rawPost('/optional', '[]', 'application/json')],
      ['JSON null', () => rawPost('/optional', 'null', 'application/json')],
      ['a bare string', () => rawPost('/optional', '"abc"', 'application/json')],
      ['a number', () => rawPost('/optional', '5', 'application/json')],
      ['a boolean', () => rawPost('/optional', 'true', 'application/json')],
      ['malformed JSON', () => rawPost('/trips', '{"lat": ', 'application/json')],
    ];

    it.each(unusable)('%s gives INVALID_INPUT with field null and no details', async (_name, run) => {
      const { res, body } = await run();
      expectInvalid(res, body);
      expect(body.error.field).toBeNull();
      expect('details' in body.error).toBe(false);
      expect(reached).not.toHaveBeenCalled();
    });

    it('{} is a normal body: valid for an all-optional DTO', async () => {
      const { res } = await post('/optional', {});
      expect(res.status).toBe(201);
    });

    it('{} is validated normally: every missing required field is listed', async () => {
      const { body } = await post('/trips', {});
      expect(pairs(body)).toEqual([
        ['lat', 'REQUIRED'],
        ['lng', 'REQUIRED'],
        ['pickup', 'REQUIRED'],
        ['stops', 'REQUIRED'],
      ]);
    });
  });

  it('a guard runs before validation: a bad body gets 401, not 400', async () => {
    const { res, body } = await post('/guarded', { nonsense: true });
    expect(res.status).toBe(401);
    expect(body.error.code).toBe('UNAUTHORIZED');
    expect(reached).not.toHaveBeenCalled();
  });

  it('UNPROTECTED ROUTE (documents the hazard the startup check in d2 closes): an interface-typed body skips validation', async () => {
    const { res, body } = await post('/loose', { name: 5, evil: true });
    // A PASSING test here means this route has NO validation at all: the wrong type and the
    // unknown field were both accepted. Nest skips validation silently for an interface, an
    // inline type, unknown, a primitive, or a class imported with "import type".
    expect(res.status).toBe(201);
    expect(body.data.got).toEqual({ name: 5, evil: true });
  });
});
