import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../common/clock.js';
import { AppException } from '../../common/errors/app.exception.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AdminSessionService } from './admin-session.service.js';
import { dummyHash, verifyPassword } from './password.js';

// POST /v1/admin/auth/login (docs/api/admin/admin-login.md). Wrong email, wrong password and a switched
// off admin all give the same UNAUTHORIZED, and an unknown email still pays for one password check.
@Injectable()
export class AdminAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: AdminSessionService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async login(email: string, password: string) {
    const admin = await this.prisma.admin.findUnique({ where: { email } });
    const passwordOk = await verifyPassword(password, admin?.passwordHash ?? (await dummyHash()));
    if (!admin || !passwordOk || !admin.isActive) throw new AppException('UNAUTHORIZED');

    const tokens = await this.sessions.create(admin.id);
    await this.prisma.admin.update({ where: { id: admin.id }, data: { lastLoginAt: this.clock() } });
    return { admin: { id: admin.id, name: admin.name, email: admin.email }, tokens };
  }
}
