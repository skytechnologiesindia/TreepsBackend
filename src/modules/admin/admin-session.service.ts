import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../common/clock.js';
import { newOpaqueToken, sha256Hex } from '../../common/tokens.js';
import { SESSION_TOKEN_TTL_SECONDS, SESSION_TOUCH_INTERVAL_MS } from '../../config/tokens.js';
import { PrismaService } from '../../prisma/prisma.service.js';

const TTL_MS = SESSION_TOKEN_TTL_SECONDS * 1000;

export interface AdminSessionInfo {
  id: string;
  adminId: string;
  expiresAt: Date;
}

// The admin's copy of SessionService: the same opaque token, sliding 30 days, only the hash stored.
// It is its own class and table so the rider and driver sessions are not touched.
@Injectable()
export class AdminSessionService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  // One session per admin: the earlier ones are deleted. Returns the only copy of the token.
  async create(adminId: string): Promise<{ accessToken: string; expiresInSeconds: number }> {
    const now = this.clock();
    const token = newOpaqueToken();
    await this.prisma.$transaction(async (tx) => {
      await tx.adminSession.deleteMany({ where: { adminId } });
      await tx.adminSession.create({
        data: { tokenHash: sha256Hex(token), adminId, expiresAt: new Date(now.getTime() + TTL_MS), createdAt: now },
      });
    });
    return { accessToken: token, expiresInSeconds: SESSION_TOKEN_TTL_SECONDS };
  }

  async findByToken(token: string): Promise<AdminSessionInfo | null> {
    const row = await this.prisma.adminSession.findUnique({ where: { tokenHash: sha256Hex(token) } });
    if (!row || row.expiresAt.getTime() <= this.clock().getTime()) return null;
    return { id: row.id, adminId: row.adminId, expiresAt: row.expiresAt };
  }

  // Sliding expiry, written at most once an hour (same rule as the other sessions).
  async touch(session: AdminSessionInfo): Promise<void> {
    const now = this.clock();
    if (now.getTime() - (session.expiresAt.getTime() - TTL_MS) < SESSION_TOUCH_INTERVAL_MS) return;
    await this.prisma.adminSession.updateMany({
      where: { id: session.id, expiresAt: session.expiresAt },
      data: { expiresAt: new Date(now.getTime() + TTL_MS) },
    });
  }

  async deleteAll(adminId: string): Promise<void> {
    await this.prisma.adminSession.deleteMany({ where: { adminId } });
  }
}
