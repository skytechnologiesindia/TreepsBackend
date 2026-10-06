import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  AppVersion,
  DeviceId,
  IndianMobile,
  Latitude,
  Longitude,
  Money,
  Nested,
  NestedList,
  OneOf,
  OtpCode,
  Optional,
  Page,
  PageSize,
  Phone,
  Required,
  Text,
  ToInt,
  UtcDate,
  Uuid,
} from './fields.js';
import { toAppException } from './to-app-exception.js';

// The pipe options planned for piece d. The limits used below are test-local values,
// not project defaults.
const OPTIONS = {
  whitelist: true,
  forbidNonWhitelisted: true,
  forbidUnknownValues: true,
  validationError: { target: false, value: false },
};

async function problems(dto: new () => object, payload: unknown) {
  const errors = await validate(plainToInstance(dto, payload as object), OPTIONS);
  return errors.length === 0
    ? []
    : (toAppException(errors).details ?? []).map((d) => [d.field, d.reason]);
}

class Coords {
  @Required(Latitude()) lat!: number;
  @Required(Longitude()) lng!: number;
}
class OptionalLat {
  @Optional(Latitude()) lat?: number;
}
class Cash {
  @Required(Money({ max: 500 })) amount!: number;
}
class Contact {
  @Required(Phone({ minDigits: 8, maxDigits: 12 })) phone!: string;
}
class IndianContact {
  @Required(IndianMobile()) phoneNumber!: string;
}
class OptionalIndianContact {
  @Optional(IndianMobile()) phoneNumber?: string;
}
class Code {
  @Required(OtpCode()) otp!: string;
}
class Install {
  @Required(DeviceId()) deviceId!: string;
}
class Build {
  @Required(AppVersion()) appVersion!: string;
}
class Wide {
  @Required(
    UtcDate({
      min: () => new Date('2000-01-01T00:00:00Z'),
      max: () => new Date('2100-01-01T00:00:00Z'),
    }),
  )
  at!: string;
}
class Narrow {
  @Required(
    UtcDate({
      min: () => new Date('2026-01-01T00:00:00Z'),
      max: () => new Date('2027-01-01T00:00:00Z'),
    }),
  )
  at!: string;
}
class AnyId {
  @Required(Uuid({ versions: 'all' })) id!: string;
}
class V4Id {
  @Required(Uuid({ versions: [4] })) id!: string;
}
class Paging {
  @ToInt() @Required(Page({ max: 50 })) page!: number;
  @ToInt() @Required(PageSize({ max: 20 })) pageSize!: number;
}
class Title {
  @Required(Text({ min: 1, max: 5 })) t!: string;
}
class Notes {
  @Required(Text({ min: 0, max: 5 })) t!: string;
}
class OneChar {
  @Required(Text({ min: 1, max: 1 })) t!: string;
}
class TwoToThree {
  @Required(Text({ min: 2, max: 3 })) t!: string;
}
class UpToSix {
  @Required(Text({ min: 1, max: 6 })) t!: string;
}
class UpToFive {
  @Required(Text({ min: 1, max: 5 })) t!: string;
}
class Tier {
  @Required(OneOf(['MINI', 'SEDAN', 'XL'])) tier!: string;
}
class Stop {
  @Required(Latitude()) lat!: number;
}
class Trip {
  @Required(Nested(() => Stop)) pickup!: Stop;
  @Required(NestedList(() => Stop, { min: 0, max: 2 })) stops!: Stop[];
}
class Forgot {
  @Required(Latitude()) lat!: number;
  extra!: number; // declared, but no Required or Optional
}

describe('latitude and longitude', () => {
  it.each([[-90], [90], [0]])('accept latitude %d', async (lat) => {
    expect(await problems(Coords, { lat, lng: 0 })).toEqual([]);
  });

  it.each([[-180], [180]])('accept longitude %d', async (lng) => {
    expect(await problems(Coords, { lat: 0, lng })).toEqual([]);
  });

  it.each([['12.5'], [NaN], [Infinity], [-Infinity], [true], [[]]])(
    'reject %j as WRONG_TYPE',
    async (lat) => {
      expect(await problems(Coords, { lat, lng: 0 })).toEqual([['lat', 'WRONG_TYPE']]);
    },
  );

  it.each([[90.0001], [-90.0001]])('reject latitude %d as OUT_OF_RANGE', async (lat) => {
    expect(await problems(Coords, { lat, lng: 0 })).toEqual([['lat', 'OUT_OF_RANGE']]);
  });

  it('rejects longitude 180.0001 as OUT_OF_RANGE', async () => {
    expect(await problems(Coords, { lat: 0, lng: 180.0001 })).toEqual([['lng', 'OUT_OF_RANGE']]);
  });
});

describe('required and optional', () => {
  it('a missing required field is REQUIRED, never WRONG_TYPE', async () => {
    expect(await problems(Coords, { lng: 0 })).toEqual([['lat', 'REQUIRED']]);
  });

  it('null on a required field is REQUIRED', async () => {
    expect(await problems(Coords, { lat: null, lng: 0 })).toEqual([['lat', 'REQUIRED']]);
  });

  it('an omitted optional field passes, and so does an explicit undefined', async () => {
    expect(await problems(OptionalLat, {})).toEqual([]);
    expect(await problems(OptionalLat, { lat: undefined })).toEqual([]);
  });

  it('null on an optional field is WRONG_TYPE', async () => {
    expect(await problems(OptionalLat, { lat: null })).toEqual([['lat', 'WRONG_TYPE']]);
  });

  it('an optional field still applies its rules when present', async () => {
    expect(await problems(OptionalLat, { lat: 91 })).toEqual([['lat', 'OUT_OF_RANGE']]);
    expect(await problems(OptionalLat, { lat: 'x' })).toEqual([['lat', 'WRONG_TYPE']]);
  });

  it('a declared field with no Required or Optional is rejected as unknown', async () => {
    expect(await problems(Forgot, { lat: 1, extra: 5 })).toEqual([['extra', 'UNKNOWN_FIELD']]);
  });
});

describe('money', () => {
  it.each([[0], [500]])('accepts %d', async (amount) => {
    expect(await problems(Cash, { amount })).toEqual([]);
  });

  it.each([[1.5], ['100'], [NaN], [2 ** 53]])('rejects %j as WRONG_TYPE', async (amount) => {
    expect(await problems(Cash, { amount })).toEqual([['amount', 'WRONG_TYPE']]);
  });

  it.each([[-1], [501]])('rejects %d as OUT_OF_RANGE', async (amount) => {
    expect(await problems(Cash, { amount })).toEqual([['amount', 'OUT_OF_RANGE']]);
  });
});

describe('phone', () => {
  it('accepts a normal E.164 number', async () => {
    expect(await problems(Contact, { phone: '+919876543210' })).toEqual([]);
  });

  it.each([
    '+91 98765 43210',
    '919876543210',
    '+0919876543210',
    '+91-9876543210',
    '+9123456',
    '+9198765432101',
    ' +919876543210',
    '+919876543210\n',
    '+٩١٩٨٧٦٥٤٣٢١٠',
  ])('rejects %j as INVALID_FORMAT', async (phone) => {
    expect(await problems(Contact, { phone })).toEqual([['phone', 'INVALID_FORMAT']]);
  });

  it('rejects a number as WRONG_TYPE', async () => {
    expect(await problems(Contact, { phone: 919876543210 })).toEqual([['phone', 'WRONG_TYPE']]);
  });
});

describe('IndianMobile', () => {
  it.each(['+919477172214', '+916000000000', '+917123456789', '+918123456789', '+919999999999'])(
    'accepts %j',
    async (phoneNumber) => {
      expect(await problems(IndianContact, { phoneNumber })).toEqual([]);
    },
  );

  it.each([
    ['9477172214', 'no +91'],
    ['+915477172214', 'first digit 5'],
    ['+910477172214', 'first digit 0'],
    ['+91947717221', '9 digits'],
    ['+9194771722141', '11 digits'],
    ['+91 9477172214', 'space inside'],
    ['+91-9477172214', 'dash inside'],
    ['+449477172214', 'not India'],
    ['919477172214', 'no plus'],
    ['0919477172214', 'zero instead of plus'],
    [' +919477172214', 'leading space'],
    ['+919477172214 ', 'trailing space'],
    ['+919477172214\n', 'trailing newline'],
    ['+91٩٤٧٧١٧٢٢١٤', 'non-ASCII digits'],
    ['+９１９４７７１７２２１４', 'full-width characters'],
    ['', 'empty string'],
  ])('rejects %j as INVALID_FORMAT (%s)', async (phoneNumber) => {
    expect(await problems(IndianContact, { phoneNumber })).toEqual([['phoneNumber', 'INVALID_FORMAT']]);
  });

  it.each([[9477172214], [919477172214], [true], [{}], [['+919477172214']]])(
    'rejects the non-string %j as WRONG_TYPE',
    async (phoneNumber) => {
      expect(await problems(IndianContact, { phoneNumber })).toEqual([['phoneNumber', 'WRONG_TYPE']]);
    },
  );

  it('a missing, undefined or null value is REQUIRED when the field is required', async () => {
    expect(await problems(IndianContact, {})).toEqual([['phoneNumber', 'REQUIRED']]);
    expect(await problems(IndianContact, { phoneNumber: undefined })).toEqual([['phoneNumber', 'REQUIRED']]);
    expect(await problems(IndianContact, { phoneNumber: null })).toEqual([['phoneNumber', 'REQUIRED']]);
  });

  it('when optional: omitted is fine, null is WRONG_TYPE, and a bad shape is still rejected', async () => {
    expect(await problems(OptionalIndianContact, {})).toEqual([]);
    expect(await problems(OptionalIndianContact, { phoneNumber: null })).toEqual([['phoneNumber', 'WRONG_TYPE']]);
    expect(await problems(OptionalIndianContact, { phoneNumber: '9477172214' })).toEqual([['phoneNumber', 'INVALID_FORMAT']]);
  });

  it('does not change the value it checks (no trimming, no +91 added)', async () => {
    const instance = plainToInstance(IndianContact, { phoneNumber: ' 9477172214' });
    await validate(instance, OPTIONS);
    expect(instance.phoneNumber).toBe(' 9477172214');
  });
});

describe('OtpCode', () => {
  it.each(['012345', '123456', '000000'])('accepts %j', async (otp) => {
    expect(await problems(Code, { otp })).toEqual([]);
  });

  it.each(['12345', '1234567', '12a456', ' 12345', '123456 ', '١٢٣٤٥٦', '', '12 456'])(
    'rejects %j as INVALID_FORMAT',
    async (otp) => {
      expect(await problems(Code, { otp })).toEqual([['otp', 'INVALID_FORMAT']]);
    },
  );

  it('a JSON number is WRONG_TYPE, and a missing or null value is REQUIRED', async () => {
    expect(await problems(Code, { otp: 123456 })).toEqual([['otp', 'WRONG_TYPE']]);
    expect(await problems(Code, {})).toEqual([['otp', 'REQUIRED']]);
    expect(await problems(Code, { otp: null })).toEqual([['otp', 'REQUIRED']]);
  });
});

describe('DeviceId', () => {
  it.each(['9f2c1b7e-3a4d-4c55-8e21-0d6f5a1b2c3d', 'abc_123', 'a', 'A-b_9', 'x'.repeat(64)])('accepts %j', async (deviceId) => {
    expect(await problems(Install, { deviceId })).toEqual([]);
  });

  it('rejects an empty string as TOO_SHORT and 65 characters as TOO_LONG', async () => {
    expect(await problems(Install, { deviceId: '' })).toEqual([['deviceId', 'TOO_SHORT']]);
    expect(await problems(Install, { deviceId: 'x'.repeat(65) })).toEqual([['deviceId', 'TOO_LONG']]);
  });

  it.each(['device 1', 'dev:1', 'dev.1', 'dev/1', ' abc', 'abc ', 'é', '😀', 'abc\n'])('rejects %j as INVALID_FORMAT', async (deviceId) => {
    expect(await problems(Install, { deviceId })).toEqual([['deviceId', 'INVALID_FORMAT']]);
  });

  it('a bad character in a 65-character value is INVALID_FORMAT (the first reason wins)', async () => {
    expect(await problems(Install, { deviceId: 'x'.repeat(64) + ' ' })).toEqual([['deviceId', 'INVALID_FORMAT']]);
  });

  it('a number is WRONG_TYPE and a missing value is REQUIRED', async () => {
    expect(await problems(Install, { deviceId: 12 })).toEqual([['deviceId', 'WRONG_TYPE']]);
    expect(await problems(Install, {})).toEqual([['deviceId', 'REQUIRED']]);
  });
});

describe('AppVersion', () => {
  it.each(['1.4.2', '10.0.123', '999.999.999', '0.0.0'])('accepts %j', async (appVersion) => {
    expect(await problems(Build, { appVersion })).toEqual([]);
  });

  it.each(['1.4', 'v1.4.2', '1.4.2-beta', '1.4.2.1', '1.4.1000', '', '1..2', '1.4.2 ', ' 1.4.2', '١.٤.٢', 'a.b.c', '1.4.2\n'])(
    'rejects %j as INVALID_FORMAT',
    async (appVersion) => {
      expect(await problems(Build, { appVersion })).toEqual([['appVersion', 'INVALID_FORMAT']]);
    },
  );

  it('a number is WRONG_TYPE and a missing value is REQUIRED', async () => {
    expect(await problems(Build, { appVersion: 1.4 })).toEqual([['appVersion', 'WRONG_TYPE']]);
    expect(await problems(Build, {})).toEqual([['appVersion', 'REQUIRED']]);
  });
});

describe('utc date', () => {
  it.each([
    '2026-09-29T10:00:00Z',
    '2026-09-29T10:00:00.5Z',
    '2026-09-29T10:00:00.123Z',
    '2028-02-29T00:00:00Z',
  ])('accepts %s', async (at) => {
    expect(await problems(Wide, { at })).toEqual([]);
  });

  it.each([
    '2026-09-29T10:00:00+05:30',
    '2026-09-29',
    '2026-02-30T00:00:00Z',
    '2026-02-29T00:00:00Z',
    '2026-09-29T24:00:00Z',
    '2026-09-29T23:59:60Z',
    '2026-09-29T10:00:00z',
    '2026-09-29T10:00:00.1234Z',
    '2026-09-29 10:00:00Z',
  ])('rejects %s as INVALID_FORMAT', async (at) => {
    expect(await problems(Wide, { at })).toEqual([['at', 'INVALID_FORMAT']]);
  });

  it('rejects years 0000 to 0099 as INVALID_FORMAT', async () => {
    // Accepted behavior, not a bug: JavaScript's Date.UTC treats years 0 to 99 as 1900 to
    // 1999, so the value cannot round-trip and is refused. No real request is dated in
    // those years, so refusing them costs nothing. Year 0100 is a valid date, and here it
    // is then refused by the range check instead.
    for (const at of ['0000-01-01T00:00:00Z', '0050-06-15T12:00:00Z', '0099-12-31T23:59:59Z']) {
      expect(await problems(Wide, { at })).toEqual([['at', 'INVALID_FORMAT']]);
    }
    expect(await problems(Wide, { at: '0100-01-01T00:00:00Z' })).toEqual([['at', 'OUT_OF_RANGE']]);
  });

  it('rejects a number as WRONG_TYPE', async () => {
    expect(await problems(Wide, { at: 20260929 })).toEqual([['at', 'WRONG_TYPE']]);
  });

  it('bounds are inclusive', async () => {
    expect(await problems(Narrow, { at: '2026-01-01T00:00:00Z' })).toEqual([]);
    expect(await problems(Narrow, { at: '2027-01-01T00:00:00Z' })).toEqual([]);
    expect(await problems(Narrow, { at: '2025-12-31T23:59:59.999Z' })).toEqual([
      ['at', 'OUT_OF_RANGE'],
    ]);
    expect(await problems(Narrow, { at: '2027-01-01T00:00:00.001Z' })).toEqual([
      ['at', 'OUT_OF_RANGE'],
    ]);
  });
});

describe('uuid', () => {
  const v4 = '3f2b8c1e-6a4d-4e2f-9b7a-1c2d3e4f5a6b';
  const v7 = '3f2b8c1e-6a4d-7e2f-9b7a-1c2d3e4f5a6b';

  it('any version accepts v4 in either case and v7', async () => {
    for (const id of [v4, v4.toUpperCase(), v7]) {
      expect(await problems(AnyId, { id })).toEqual([]);
    }
  });

  it.each([
    '00000000-0000-0000-0000-000000000000',
    '3f2b8c1e6a4d4e2f9b7a1c2d3e4f5a6b',
    '3f2b8c1e-6a4d-4e2f-cb7a-1c2d3e4f5a6b',
    `{${v4}}`,
  ])('rejects %s as INVALID_FORMAT', async (id) => {
    expect(await problems(AnyId, { id })).toEqual([['id', 'INVALID_FORMAT']]);
  });

  it('v4 only rejects a v7', async () => {
    expect(await problems(V4Id, { id: v4 })).toEqual([]);
    expect(await problems(V4Id, { id: v7 })).toEqual([['id', 'INVALID_FORMAT']]);
  });

  it('rejects a number as WRONG_TYPE', async () => {
    expect(await problems(AnyId, { id: 5 })).toEqual([['id', 'WRONG_TYPE']]);
  });
});

describe('page and pageSize', () => {
  it('accept 1 and their maximum', async () => {
    expect(await problems(Paging, { page: 1, pageSize: 20 })).toEqual([]);
    expect(await problems(Paging, { page: 50, pageSize: 1 })).toEqual([]);
  });

  it('reject 0, a value above the maximum and a negative as OUT_OF_RANGE', async () => {
    expect(await problems(Paging, { page: 0, pageSize: 21 })).toEqual([
      ['page', 'OUT_OF_RANGE'],
      ['pageSize', 'OUT_OF_RANGE'],
    ]);
    expect(await problems(Paging, { page: 51, pageSize: -1 })).toEqual([
      ['page', 'OUT_OF_RANGE'],
      ['pageSize', 'OUT_OF_RANGE'],
    ]);
  });

  it('reject 1.5 and a non-numeric string as WRONG_TYPE', async () => {
    expect(await problems(Paging, { page: 1.5, pageSize: 'abc' })).toEqual([
      ['page', 'WRONG_TYPE'],
      ['pageSize', 'WRONG_TYPE'],
    ]);
  });
});

describe('ToInt', () => {
  const convert = (page: unknown) => (plainToInstance(Paging, { page }) as { page: unknown }).page;

  it.each([
    ['2', 2],
    ['0', 0],
    ['10', 10],
    [2, 2],
  ])('converts %j to %j', (input, output) => {
    expect(convert(input)).toBe(output);
  });

  it.each(['', '2.5', ' 2', '2 ', '0x10', '1e3', '-1', '+1', '007', '٢', '9007199254740993'])(
    'leaves %j unchanged',
    (input) => {
      expect(convert(input)).toBe(input);
    },
  );

  it('leaves numbers, null, undefined and arrays unchanged', () => {
    for (const v of [2.5, null, undefined, ['1']]) expect(convert(v)).toEqual(v);
  });

  it('makes a leftover string fail as WRONG_TYPE and lets a converted one pass', async () => {
    expect(await problems(Paging, { page: '0x10', pageSize: '5' })).toEqual([
      ['page', 'WRONG_TYPE'],
    ]);
    expect(await problems(Paging, { page: '2', pageSize: '5' })).toEqual([]);
  });
});

describe('text', () => {
  it('an empty required text is REQUIRED, not TOO_SHORT', async () => {
    expect(await problems(Title, { t: '' })).toEqual([['t', 'REQUIRED']]);
  });

  it('accepts 1 to 5 characters, rejects 6 as TOO_LONG and a number as WRONG_TYPE', async () => {
    expect(await problems(Title, { t: 'abcde' })).toEqual([]);
    expect(await problems(Title, { t: 'abcdef' })).toEqual([['t', 'TOO_LONG']]);
    expect(await problems(Title, { t: 5 })).toEqual([['t', 'WRONG_TYPE']]);
  });

  it('accepts an empty text when the minimum is 0', async () => {
    expect(await problems(Notes, { t: '' })).toEqual([]);
  });

  it('counts an emoji as ONE character at the limit boundary', async () => {
    expect('😀'.length).toBe(2); // two UTF-16 units, one code point
    expect(await problems(OneChar, { t: '😀' })).toEqual([]);
    expect(await problems(OneChar, { t: '😀😀' })).toEqual([['t', 'TOO_LONG']]);
    expect(await problems(Title, { t: '😀'.repeat(5) })).toEqual([]);
    expect(await problems(Title, { t: '😀'.repeat(6) })).toEqual([['t', 'TOO_LONG']]);
    expect(await problems(TwoToThree, { t: '😀' })).toEqual([['t', 'TOO_SHORT']]);
    expect(await problems(TwoToThree, { t: '😀😀' })).toEqual([]);
  });

  it('counts a Hindi string by characters, not bytes', async () => {
    const hindi = 'नमस्ते'; // 6 code points, 18 bytes in UTF-8
    expect(Buffer.byteLength(hindi)).toBeGreaterThan(6);
    expect(await problems(UpToSix, { t: hindi })).toEqual([]);
    expect(await problems(UpToFive, { t: hindi })).toEqual([['t', 'TOO_LONG']]);
  });

  it('rejects the character U+0000 as INVALID_FORMAT (Postgres cannot store it)', async () => {
    expect(await problems(Title, { t: '\u0000' })).toEqual([['t', 'INVALID_FORMAT']]);
    expect(await problems(Title, { t: 'ab\u0000cd' })).toEqual([['t', 'INVALID_FORMAT']]);
    expect(await problems(Title, { t: 'abcdef\u0000' })).toEqual([['t', 'INVALID_FORMAT']]);
  });
});

describe('oneOf', () => {
  it('accepts a listed value, rejects others as NOT_ALLOWED and a number as WRONG_TYPE', async () => {
    expect(await problems(Tier, { tier: 'MINI' })).toEqual([]);
    expect(await problems(Tier, { tier: 'mini' })).toEqual([['tier', 'NOT_ALLOWED']]);
    expect(await problems(Tier, { tier: 5 })).toEqual([['tier', 'WRONG_TYPE']]);
  });
});

describe('nested objects and lists', () => {
  it('rejects unknown fields inside them and names every path, sorted', async () => {
    const payload = { pickup: { lat: 'x', foo: 1 }, stops: [{ lat: 1 }, { lat: 200, bar: 2 }] };
    expect(await problems(Trip, payload)).toEqual([
      ['pickup.foo', 'UNKNOWN_FIELD'],
      ['pickup.lat', 'WRONG_TYPE'],
      ['stops.1.bar', 'UNKNOWN_FIELD'],
      ['stops.1.lat', 'OUT_OF_RANGE'],
    ]);
  });

  it('an array is not an object, and an object is not a list', async () => {
    expect(await problems(Trip, { pickup: [], stops: [] })).toEqual([['pickup', 'WRONG_TYPE']]);
    expect(await problems(Trip, { pickup: { lat: 1 }, stops: { lat: 1 } })).toEqual([
      ['stops', 'WRONG_TYPE'],
    ]);
  });

  it('a non-object list item is WRONG_TYPE at its index', async () => {
    expect(await problems(Trip, { pickup: { lat: 1 }, stops: [5, null] })).toEqual([
      ['stops.0', 'WRONG_TYPE'],
      ['stops.1', 'WRONG_TYPE'],
    ]);
  });

  it('list length limits give TOO_LONG', async () => {
    const stops = [{ lat: 1 }, { lat: 1 }, { lat: 1 }];
    expect(await problems(Trip, { pickup: { lat: 1 }, stops })).toEqual([['stops', 'TOO_LONG']]);
  });

  it('a null nested object that is required is REQUIRED', async () => {
    expect(await problems(Trip, { pickup: null, stops: [] })).toEqual([['pickup', 'REQUIRED']]);
  });
});

describe('required limits are compile errors and bad limits throw', () => {
  it('forgetting a required limit does not compile (and throws if forced)', () => {
    // @ts-expect-error Money needs { max }
    expect(() => Money()).toThrow();
    // @ts-expect-error Money needs { max }
    expect(() => Money({})).toThrow();
    // @ts-expect-error Phone needs { minDigits, maxDigits }
    expect(() => Phone()).toThrow();
    // @ts-expect-error Page needs { max }
    expect(() => Page()).toThrow();
    // @ts-expect-error PageSize needs { max }
    expect(() => PageSize()).toThrow();
    // @ts-expect-error UtcDate needs { min, max }
    expect(() => UtcDate()).toThrow();
    // @ts-expect-error Text needs { min, max }
    expect(() => Text()).toThrow();
    // @ts-expect-error Uuid needs { versions }
    expect(() => Uuid()).toThrow();
  });

  it('a shared type cannot be used as a decorator without Required or Optional', () => {
    expect(() => {
      class Bad {
        // @ts-expect-error a FieldType is not a decorator
        @Latitude() lat!: number;
      }
      return Bad;
    }).toThrow(TypeError);
  });

  it('nonsense limits throw a RangeError', () => {
    expect(() => Money({ max: -1 })).toThrow(RangeError);
    expect(() => Money({ max: 1.5 })).toThrow(RangeError);
    expect(() => Page({ max: 0 })).toThrow(RangeError);
    expect(() => Text({ min: 5, max: 2 })).toThrow(RangeError);
    expect(() => Phone({ minDigits: 8, maxDigits: 16 })).toThrow(RangeError);
    expect(() => Phone({ minDigits: 9, maxDigits: 8 })).toThrow(RangeError);
    expect(() => Uuid({ versions: [] })).toThrow(RangeError);
    expect(() => OneOf([])).toThrow(RangeError);
  });

  describe('UtcDate limits are checked once at definition time', () => {
    it('forgetting the limits gives a RangeError', () => {
      // @ts-expect-error UtcDate needs { min, max }
      expect(() => UtcDate()).toThrow(RangeError);
    });

    it('a limit that is not a function gives a RangeError', () => {
      expect(() => UtcDate({ min: new Date() as never, max: () => new Date() })).toThrow(
        RangeError,
      );
      expect(() => UtcDate({ min: () => new Date(), max: new Date() as never })).toThrow(
        RangeError,
      );
    });

    it('min after max gives a RangeError', () => {
      expect(() =>
        UtcDate({
          min: () => new Date('2027-01-01T00:00:00Z'),
          max: () => new Date('2026-01-01T00:00:00Z'),
        }),
      ).toThrow(RangeError);
    });

    it('a limit returning an invalid Date gives a RangeError', () => {
      expect(() => UtcDate({ min: () => new Date(NaN), max: () => new Date() })).toThrow(
        RangeError,
      );
      expect(() => UtcDate({ min: () => new Date(), max: () => new Date(NaN) })).toThrow(
        RangeError,
      );
    });

    it('a limit returning something that is not a Date gives a RangeError', () => {
      expect(() =>
        UtcDate({ min: (() => '2026-01-01') as never, max: () => new Date() }),
      ).toThrow(RangeError);
    });

    it('the message names the problem and prints no date', () => {
      const secret = new Date('2031-07-04T05:06:07Z');
      try {
        UtcDate({ min: () => secret, max: () => new Date('2026-01-01T00:00:00Z') });
        expect.unreachable('should have thrown');
      } catch (error) {
        expect((error as Error).message).toContain('min() must not be after max()');
        expect((error as Error).message).not.toContain('2031');
        expect((error as Error).message).not.toContain(String(secret.getTime()));
      }
    });

    it('accepts valid limits: fixed, relative, and min equal to max', () => {
      const t = new Date('2026-01-01T00:00:00Z');
      expect(() => UtcDate({ min: () => t, max: () => t })).not.toThrow();
      expect(() =>
        UtcDate({ min: () => new Date(), max: () => new Date(Date.now() + 60_000) }),
      ).not.toThrow();
    });
  });
});
