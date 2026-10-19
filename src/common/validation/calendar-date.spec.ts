import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CalendarDate, Required, parseCalendarDate } from './fields.js';

const MIN = new Date('2000-01-01T00:00:00.000Z');
const MAX = new Date('2030-12-31T00:00:00.000Z');

class Probe {
  @Required(CalendarDate({ min: () => MIN, max: () => MAX })) day!: unknown;
}

async function reasonsFor(day: unknown): Promise<string[]> {
  const errors = await validate(plainToInstance(Probe, { day }));
  return errors.flatMap((error) => Object.keys(error.constraints ?? {}));
}

describe('CalendarDate', () => {
  it('accepts a real date inside the range', async () => {
    expect(await reasonsFor('2026-10-16')).toEqual([]);
    expect(await reasonsFor('2000-01-01')).toEqual([]);
    expect(await reasonsFor('2030-12-31')).toEqual([]);
  });

  it('accepts 29 February only in a leap year', async () => {
    expect(await reasonsFor('2028-02-29')).toEqual([]);
    expect(await reasonsFor('2027-02-29')).toContain('treepsInvalidFormat');
  });

  it('refuses a date that is not a real calendar date', async () => {
    expect(await reasonsFor('2026-13-01')).toContain('treepsInvalidFormat');
    expect(await reasonsFor('2026-04-31')).toContain('treepsInvalidFormat');
    expect(await reasonsFor('0099-01-01')).toContain('treepsInvalidFormat');
  });

  it('refuses text that is not exactly YYYY-MM-DD', async () => {
    for (const bad of ['2026-1-1', '2026/10/16', '16-10-2026', '2026-10-16T00:00:00Z', ' 2026-10-16', '2026-10-16 ', '']) {
      expect(await reasonsFor(bad)).toContain('treepsInvalidFormat');
    }
  });

  it('refuses a value that is not a string', async () => {
    expect(await reasonsFor(20261016)).toContain('treepsWrongType');
    expect(await reasonsFor(null)).not.toEqual([]);
  });

  it('refuses a date outside the range', async () => {
    expect(await reasonsFor('1999-12-31')).toContain('treepsOutOfRange');
    expect(await reasonsFor('2031-01-01')).toContain('treepsOutOfRange');
  });

  it('stops the server at startup when the limits are broken', () => {
    expect(() => CalendarDate({ min: () => MAX, max: () => MIN })).toThrow(RangeError);
  });

  it('reads a date as midnight UTC', () => {
    expect(parseCalendarDate('2026-10-16')).toBe(Date.UTC(2026, 9, 16));
    expect(parseCalendarDate('nope')).toBeUndefined();
  });
});
