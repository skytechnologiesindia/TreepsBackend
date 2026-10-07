// What Prisma 7 with the pg adapter throws on a unique violation (checked against a real Postgres).
class UniqueViolation extends Error {
  readonly code = 'P2002';
  readonly meta: Row;
  constructor(index: string) {
    super(`Unique constraint failed on ${index}`);
    this.meta = { driverAdapterError: { cause: { kind: 'UniqueConstraintViolation', constraint: { index } } }, modelName: 'Rider' };
  }
}

// A small in-memory stand-in for PrismaService, with the tables the rider and driver auth routes use. It
// understands only the Prisma features those routes call (equality, null, lt, gt, count, increment,
// decrement, orderBy createdAt desc, upsert on the riderId_deviceId key) and an interactive
// $transaction that rolls back when the callback throws. Tests can make one operation fail.
type Row = Record<string, any>;

const NOW = () => new Date();

function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return a === b;
}

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, condition]) => {
    const value = row[key];
    if (condition === null) return value === null;
    if (condition instanceof Date || typeof condition !== 'object') return sameValue(value, condition);
    const c = condition as { lt?: number | Date; gt?: number | Date };
    const num = (x: unknown) => (x instanceof Date ? x.getTime() : (x as number));
    if (c.lt !== undefined && !(value !== null && num(value) < num(c.lt))) return false;
    if (c.gt !== undefined && !(value !== null && num(value) > num(c.gt))) return false;
    return true;
  });
}

function flattenWhere(where: Row): Row {
  const flat: Row = {};
  for (const [key, value] of Object.entries(where)) {
    if (key === 'riderId_deviceId' || key === 'driverId_deviceId') Object.assign(flat, value);
    else flat[key] = value;
  }
  return flat;
}

function applyData(row: Row, data: Row): void {
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === 'object' && !(value instanceof Date) && ('increment' in value || 'decrement' in value)) {
      row[key] += (value.increment ?? 0) - (value.decrement ?? 0);
    } else {
      row[key] = value;
    }
  }
}

export class InMemoryAuthDb {
  tables: Record<string, Row[]> = { otpSession: [], rider: [], device: [], refreshToken: [], driver: [], driverDevice: [], driverRefreshToken: [] };
  private nextId = 1;
  // Make one operation throw, for example 'device.upsert' (used to test the transaction).
  failOn: string | null = null;
  // Make any write fail whose arguments match, for example one that carries registrationTokenHash.
  failWhen: ((operation: string, args: Row) => boolean) | null = null;
  // The error the injected failures throw (default: a plain Error).
  failError: Error | null = null;
  // How many times each operation was called, for example 'rider.findUnique'.
  calls: Record<string, number> = {};

  private touch(name: string, args: Row = {}): void {
    this.calls[name] = (this.calls[name] ?? 0) + 1;
    if (this.failOn === name || this.failWhen?.(name, args)) throw this.failError ?? new Error('injected database failure');
  }

  private table(name: string) {
    const rows = () => this.tables[name];
    const defaults = (): Row => {
      const base: Row = { id: `id-${this.nextId++}` };
      if (name === 'otpSession') Object.assign(base, { attempts: 0, verifiedAt: null, consumedAt: null, registrationTokenHash: null, registrationExpiresAt: null, createdAt: NOW() });
      if (name === 'refreshToken' || name === 'driverRefreshToken') Object.assign(base, { revokedAt: null, createdAt: NOW() });
      if (name === 'device' || name === 'driverDevice') Object.assign(base, { fcmToken: null });
      if (name === 'driver') Object.assign(base, { deletedAt: null });
      return base;
    };
    const find = (where: Row) => rows().filter((row) => matches(row, flattenWhere(where)));
    return {
      findFirst: async ({ where = {}, orderBy }: { where?: Row; orderBy?: { createdAt: 'desc' } }) => {
        this.touch(`${name}.findFirst`);
        const found = find(where);
        if (orderBy) found.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return found[0] ?? null;
      },
      findUnique: async ({ where }: { where: Row }) => {
        this.touch(`${name}.findUnique`);
        return find(where)[0] ?? null;
      },
      count: async ({ where = {} }: { where?: Row }) => {
        this.touch(`${name}.count`);
        return find(where).length;
      },
      aggregate: async ({ where = {} }: { where?: Row; _sum: Row }) => {
        this.touch(`${name}.aggregate`);
        return { _sum: { attempts: find(where).reduce((sum, row) => sum + (row.attempts ?? 0), 0) } };
      },
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        this.touch(`${name}.updateMany`, { where, data });
        const found = find(where);
        for (const row of found) applyData(row, data);
        return { count: found.length };
      },
      update: async ({ where, data }: { where: Row; data: Row }) => {
        this.touch(`${name}.update`, { where, data });
        const row = find(where)[0];
        if (!row) throw new Error('record to update not found');
        applyData(row, data);
        return row;
      },
      create: async ({ data }: { data: Row }) => {
        this.touch(`${name}.create`, { data });
        // Like the real unique indexes on Rider.phoneNumber, Rider.email and Driver.phoneNumber.
        if (name === 'driver' && rows().some((r) => r.phoneNumber === data.phoneNumber)) throw new UniqueViolation('Driver_phoneNumber_key');
        if (name === 'rider') {
          if (rows().some((r) => r.phoneNumber === data.phoneNumber)) throw new UniqueViolation('Rider_phoneNumber_key');
          if (data.email != null && rows().some((r) => r.email === data.email)) throw new UniqueViolation('Rider_email_key');
        }
        const row = { ...defaults(), ...data };
        rows().push(row);
        return row;
      },
      upsert: async ({ where, create, update }: { where: Row; create: Row; update: Row }) => {
        this.touch(`${name}.upsert`, { where, data: create });
        const row = find(where)[0];
        if (row) {
          applyData(row, update);
          return row;
        }
        const created = { ...defaults(), ...create };
        rows().push(created);
        return created;
      },
    };
  }

  otpSession = this.table('otpSession');
  rider = this.table('rider');
  device = this.table('device');
  refreshToken = this.table('refreshToken');
  driver = this.table('driver');
  driverDevice = this.table('driverDevice');
  driverRefreshToken = this.table('driverRefreshToken');

  // The callback runs on this same object; if it throws, every table goes back to how it was.
  async $transaction<T>(fn: (tx: InMemoryAuthDb) => Promise<T>): Promise<T> {
    const snapshot = structuredClone(this.tables);
    try {
      return await fn(this);
    } catch (error) {
      this.tables = snapshot;
      throw error;
    }
  }

  // Test helpers
  addRider(overrides: Row = {}): Row {
    const rider: Row = {
      id: `rider-${this.nextId++}`,
      phoneNumber: '+919477172214',
      fullName: 'Asha Verma',
      email: null,
      gender: null,
      dateOfBirth: null,
      profilePicture: null,
      registeredCity: 'Ranchi',
      registeredState: 'Jharkhand',
      status: 'ACTIVE',
      isPhoneVerified: true,
      isEmailVerified: false,
      isProfileComplete: false,
      lastLoginAt: null,
      deletedAt: null,
      createdAt: new Date('2026-01-02T03:04:05.678Z'),
      updatedAt: new Date('2026-01-02T03:04:05.678Z'),
      ...overrides,
    };
    this.tables.rider.push(rider);
    return rider;
  }

  addDriver(overrides: Row = {}): Row {
    const driver: Row = {
      id: `driver-${this.nextId++}`,
      phoneNumber: '+919477172214',
      status: 'APPROVED',
      isPhoneVerified: true,
      lastLoginAt: null,
      deletedAt: null,
      createdAt: new Date('2026-01-02T03:04:05.678Z'),
      updatedAt: new Date('2026-01-02T03:04:05.678Z'),
      ...overrides,
    };
    this.tables.driver.push(driver);
    return driver;
  }

  addSession(overrides: Row = {}): Row {
    const session: Row = { id: `session-${this.nextId++}`, phoneNumber: '+919477172214', purpose: 'RIDER_AUTH', providerSessionId: 'fake-session-1', attempts: 0, verifiedAt: null, consumedAt: null, registrationTokenHash: null, registrationExpiresAt: null, createdAt: NOW(), expiresAt: new Date(Date.now() + 300_000), ...overrides };
    this.tables.otpSession.push(session);
    return session;
  }
}
