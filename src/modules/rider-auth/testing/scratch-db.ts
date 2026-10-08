import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { config as loadDotenv } from 'dotenv';
import pg from 'pg';

// A real Postgres database for the few tests that need real locks and real unique indexes (the
// in-memory test database has neither). In Express terms: an integration test against a throwaway
// Mongo database instead of a mock.
//
// Safety: the database names are constants here, never read from the environment, and none is
// treeps_db. Only the host, port, user and password come from DATABASE_URL. Each race spec has its
// own database, because spec files run in parallel and would wipe each other's rows. Every function
// checks current_database() before it deletes anything.
export const SCRATCH_DB_NAME = 'treeps_scratch_register';
export const SCRATCH_DRIVER_DB_NAME = 'treeps_scratch_driver';
export const SCRATCH_RIDER_VERIFY_DB_NAME = 'treeps_scratch_rider_verify';
export type ScratchName = typeof SCRATCH_DB_NAME | typeof SCRATCH_DRIVER_DB_NAME | typeof SCRATCH_RIDER_VERIFY_DB_NAME;
export const PG_TESTS_ENABLED = process.env.RUN_PG_TESTS === '1';

function urlFor(database: string): string {
  loadDotenv({ quiet: true });
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is missing (needed for host and credentials only)');
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = `/${database}`;
  return url.toString();
}

async function ensureDatabaseExists(name: ScratchName): Promise<void> {
  const admin = new pg.Client({ connectionString: urlFor('postgres') });
  await admin.connect();
  try {
    const found = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (found.rowCount === 0) await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
}

async function assertScratch(pool: pg.Pool, name: ScratchName, action: string): Promise<void> {
  const current = await pool.query('SELECT current_database() AS name');
  if (current.rows[0].name !== name) throw new Error(`Refusing to ${action}: not the scratch database`);
}

// Runs prisma/migrations/*/migration.sql in order, skipping the ones already applied (remembered in
// a small table of this throwaway database). It is the same SQL `prisma migrate deploy` runs,
// without Prisma's own bookkeeping.
async function ensureSchema(pool: pg.Pool, name: ScratchName): Promise<void> {
  await assertScratch(pool, name, 'run migrations');
  await pool.query('CREATE TABLE IF NOT EXISTS _scratch_migrations (name text PRIMARY KEY)');
  const root = join(process.cwd(), 'prisma', 'migrations');
  const dirs = readdirSync(root).filter((d) => /^\d+_/.test(d)).sort();
  const applied = new Set((await pool.query('SELECT name FROM _scratch_migrations')).rows.map((r) => r.name as string));
  if (applied.size === 0 && (await pool.query(`SELECT to_regclass('"Rider"') AS rider`)).rows[0].rider !== null) {
    // A scratch database made before this table existed already has every migration but the newest.
    for (const dir of dirs.slice(0, -1)) await pool.query('INSERT INTO _scratch_migrations VALUES ($1)', [dir]);
    dirs.slice(0, -1).forEach((dir) => applied.add(dir));
  }
  for (const dir of dirs.filter((d) => !applied.has(d))) {
    await pool.query(readFileSync(join(root, dir, 'migration.sql'), 'utf8'));
    await pool.query('INSERT INTO _scratch_migrations VALUES ($1)', [dir]);
  }
}

export interface ScratchDb {
  name: ScratchName;
  prisma: PrismaClient;
  pool: pg.Pool;
  close(): Promise<void>;
}

export async function openScratchDb(name: ScratchName = SCRATCH_DB_NAME): Promise<ScratchDb> {
  await ensureDatabaseExists(name);
  const pool = new pg.Pool({ connectionString: urlFor(name) });
  await ensureSchema(pool, name);
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  await prisma.$connect();
  return {
    name,
    prisma,
    pool,
    close: async () => {
      await prisma.$disconnect();
    },
  };
}

// Empties the rider auth tables, only after confirming this really is the scratch database.
export async function emptyRiderAuthTables(db: ScratchDb): Promise<void> {
  await assertScratch(db.pool, db.name, 'delete');
  await db.prisma.refreshToken.deleteMany();
  await db.prisma.device.deleteMany();
  await db.prisma.otpSession.deleteMany();
  await db.prisma.rider.deleteMany();
}

// Same for the driver auth tables.
export async function emptyDriverAuthTables(db: ScratchDb): Promise<void> {
  await assertScratch(db.pool, db.name, 'delete');
  await db.prisma.driverRefreshToken.deleteMany();
  await db.prisma.driverDevice.deleteMany();
  await db.prisma.otpSession.deleteMany();
  await db.prisma.driver.deleteMany();
}
