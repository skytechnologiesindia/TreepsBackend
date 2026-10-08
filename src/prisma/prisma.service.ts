import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly pool: pg.Pool;

  constructor() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is missing in environment variables');
    }

    // Every connection runs in UTC (timestamps are UTC, CLAUDE.md rule 11). Without this, a Postgres
    // server whose time zone is not UTC (for example Asia/Calcutta) compares a timestamptz column with
    // a zoneless Date parameter in its own local time, which shifts every `createdAt > now - X` query
    // by the zone offset (found by the real-Postgres e2e smoke test: the 30 s resend cooldown became
    // 5.5 hours).
    const pool = new pg.Pool({ connectionString, options: '-c timezone=UTC' });
    const adapter = new PrismaPg(pool);

    super({ adapter });
    this.pool = pool;
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
    if (!this.pool.ended) await this.pool.end(); // the adapter does not close a pool it was given
  }
}
