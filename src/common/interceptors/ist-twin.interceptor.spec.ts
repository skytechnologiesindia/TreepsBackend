import { addIstTwins } from './ist-twin.interceptor.js';

const run = (value: unknown) => addIstTwins(value) as any;

describe('addIstTwins', () => {
  it('a Date gets <key>Ist next to it, and the Date itself is unchanged', () => {
    const when = new Date('2026-10-07T13:53:10.203Z');
    const out = run({ createdAt: when });
    expect(out.createdAt).toBe(when);
    expect(out.createdAtIst).toBe('07-10-2026 19:23:10');
    expect(Object.keys(out)).toEqual(['createdAt', 'createdAtIst']); // the twin sits right after its key
  });

  it('an ISO string gets a twin, and the string is unchanged', () => {
    const out = run({ expiresAt: '2026-10-07T13:53:10.203Z' });
    expect(out.expiresAt).toBe('2026-10-07T13:53:10.203Z');
    expect(out.expiresAtIst).toBe('07-10-2026 19:23:10');
  });

  it('works for any key name, and for an ISO string with an offset or without milliseconds', () => {
    const out = run({ whenever: '2026-10-07T13:53:10Z', other: '2026-10-07T19:23:10+05:30' });
    expect(out.wheneverIst).toBe('07-10-2026 19:23:10');
    expect(out.otherIst).toBe('07-10-2026 19:23:10');
  });

  it('crosses midnight and the year correctly (IST is UTC+05:30)', () => {
    expect(run({ t: '2026-12-31T20:00:00.000Z' }).tIst).toBe('01-01-2027 01:30:00');
    expect(run({ t: '2026-03-01T18:29:59.999Z' }).tIst).toBe('01-03-2026 23:59:59');
    expect(run({ t: '2026-03-01T18:30:00.000Z' }).tIst).toBe('02-03-2026 00:00:00');
  });

  it('a null stays null and gets no twin (without key names a null cannot be known to be a date)', () => {
    const out = run({ lastLoginAt: null });
    expect(out).toEqual({ lastLoginAt: null });
  });

  it('nested objects and arrays of objects are handled', () => {
    const out = run({
      rider: { id: 'r1', createdAt: '2026-10-07T13:53:10.203Z', inner: { at: new Date('2026-10-07T00:00:00.000Z') } },
      items: [{ at: '2026-10-07T13:53:10.203Z' }, { at: null }, 5],
    });
    expect(out.rider.createdAtIst).toBe('07-10-2026 19:23:10');
    expect(out.rider.inner.atIst).toBe('07-10-2026 05:30:00');
    expect(out.items[0].atIst).toBe('07-10-2026 19:23:10');
    expect(out.items[1]).toEqual({ at: null });
    expect(out.items[2]).toBe(5);
  });

  it('a top-level array of objects is handled', () => {
    expect(run([{ at: '2026-10-07T13:53:10.203Z' }])[0].atIst).toBe('07-10-2026 19:23:10');
  });

  it.each([
    ['a date-only string', '2026-10-07'],
    ['a time without a zone', '2026-10-07T13:53:10'],
    ['free text containing a date', 'Booked on 2026-10-07T13:53:10.203Z by Asha'],
    ['a plain word', 'ACTIVE'],
    ['an impossible month', '2026-13-07T13:53:10.203Z'],
    ['an impossible day (Feb 31)', '2026-02-31T13:53:10.203Z'],
    ['an impossible hour', '2026-10-07T25:53:10.203Z'],
    ['a number', 1_790_000_000_000],
    ['a boolean', true],
    ['an invalid Date', new Date('nope')],
  ])('%s gets no twin and is unchanged', (_name, value) => {
    const out = run({ field: value });
    expect(out).toEqual({ field: value });
  });

  it('key names do not matter: a value under createdAt that is not a date-time gets no twin', () => {
    expect(run({ createdAt: '2026-10-07' })).toEqual({ createdAt: '2026-10-07' });
    expect(run({ createdAt: 'yesterday' })).toEqual({ createdAt: 'yesterday' });
  });

  it('never overwrites a key that is already there', () => {
    const out = run({ createdAt: '2026-10-07T13:53:10.203Z', createdAtIst: 'mine' });
    expect(out.createdAtIst).toBe('mine');
  });

  it('strings, numbers, null, undefined and arrays of scalars pass through unchanged', () => {
    expect(run('2026-10-07T13:53:10.203Z')).toBe('2026-10-07T13:53:10.203Z'); // no key to put a twin under
    expect(run(42)).toBe(42);
    expect(run(null)).toBeNull();
    expect(run(undefined)).toBeUndefined();
    expect(run(['2026-10-07T13:53:10.203Z', 1])).toEqual(['2026-10-07T13:53:10.203Z', 1]);
  });

  it('does not change the input object', () => {
    const input = { at: '2026-10-07T13:53:10.203Z', nested: { at: new Date('2026-10-07T13:53:10.203Z') } };
    const copy = structuredClone(input);
    addIstTwins(input);
    expect(input).toEqual(copy);
  });
});
