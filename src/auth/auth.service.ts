import { Injectable, UnauthorizedException } from '@nestjs/common';
import { FirebaseService } from './firebase.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

@Injectable()
export class AuthService {
  constructor(
    private readonly firebaseService: FirebaseService,
    private readonly prisma: PrismaService,
  ) {}

  async authenticateWithFirebase(idToken: string) {
    const decodedToken = await this.firebaseService.verifyIdToken(idToken);
    const phoneNumber = decodedToken.phone_number;

    if (!phoneNumber) {
      throw new UnauthorizedException('Firebase token does not contain a phone number');
    }

    let user = await this.prisma.user.findUnique({
      where: { phoneNumber },
    });

    if (!user) {
      user = await this.prisma.user.create({
        data: {
          phoneNumber,
          role: 'RIDER',
          isPhoneVerified: true,
        },
      });
    }

    return {
      id: user.id,
      phoneNumber: user.phoneNumber,
      role: user.role,
      isPhoneVerified: user.isPhoneVerified,
    };
  }
}