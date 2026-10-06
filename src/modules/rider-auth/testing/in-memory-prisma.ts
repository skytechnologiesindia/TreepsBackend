// A tiny stand-in for PrismaService in tests: it keeps OtpSession rows in an array and supports only
// what the send-otp service uses. Touching anything else (for example the Rider table) throws, so a
// test proves the service never reads it.
export interface OtpSessionRow {
  id: string;
  phoneNumber: string;
  purpose: string;
  providerSessionId: string;
  attempts: number;
  expiresAt: Date;
  verifiedAt: Date | null;
  consumedAt: Date | null;
  registrationTokenHash: string | null;
  registrationExpiresAt: Date | null;
  createdAt: Date;
}

interface Where {
  phoneNumber?: string;
  createdAt?: { gt: Date };
}

export function inMemoryPrisma() {
  const rows: OtpSessionRow[] = [];
  let nextId = 1;
  const matches = (row: OtpSessionRow, where: Where) =>
    (where.phoneNumber === undefined || row.phoneNumber === where.phoneNumber) &&
    (where.createdAt === undefined || row.createdAt.getTime() > where.createdAt.gt.getTime());

  const otpSession = {
    async findFirst({ where }: { where: Where; select?: unknown }) {
      return rows.find((row) => matches(row, where)) ?? null;
    },
    async count({ where }: { where: Where }) {
      return rows.filter((row) => matches(row, where)).length;
    },
    async create({ data }: { data: Partial<OtpSessionRow> & { phoneNumber: string; purpose: string; providerSessionId: string; expiresAt: Date } }) {
      const row: OtpSessionRow = {
        id: `row-${nextId++}`,
        attempts: 0,
        verifiedAt: null,
        consumedAt: null,
        registrationTokenHash: null,
        registrationExpiresAt: null,
        createdAt: new Date(),
        ...data,
      };
      rows.push(row);
      return row;
    },
  };

  // Only the tables and raw-query methods that send-otp must never use throw. Other property reads
  // (Nest looks at "constructor" and similar when it registers a provider) are harmless.
  const FORBIDDEN = new Set(['rider', 'savedPlace', 'emergencyContact', 'device', 'refreshToken', '$queryRaw', '$executeRaw', '$transaction']);
  const prisma = new Proxy({ otpSession } as Record<string | symbol, unknown>, {
    get(target, property) {
      if (typeof property === 'string' && FORBIDDEN.has(property)) {
        throw new Error(`The test database was asked for "${property}", which send-otp must never use`);
      }
      return target[property];
    },
  });
  return { prisma, rows };
}
