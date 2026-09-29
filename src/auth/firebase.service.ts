// import { Injectable, OnModuleInit } from '@nestjs/common';
// import { initializeApp, getApps, cert } from 'firebase-admin/app';
// import { getAuth } from 'firebase-admin/auth';

// @Injectable()
// export class FirebaseService implements OnModuleInit {
//   onModuleInit() {
//     if (!getApps().length) {
//       initializeApp({
//         credential: cert({
//           projectId: process.env.FIREBASE_PROJECT_ID,
//           clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
//           privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
//         }),
//       });
//     }
//   }

//   async verifyIdToken(idToken: string) {
//     try {
//       const decodedToken = await getAuth().verifyIdToken(idToken);
//       return decodedToken;
//     } catch (error) {
//       throw new Error('Invalid or expired Firebase token');
//     }
//   }
// }



import { Injectable, UnauthorizedException } from '@nestjs/common';

@Injectable()
export class FirebaseService {
  async verifyIdToken(idToken: string) {
    // MOCK FOR DEVELOPMENT: If you send "test-token-123", it simulates a successful phone verification
    if (idToken === 'test-token-123') {
      return {
        phone_number: '+19876543210',
        uid: 'mock-firebase-uid-999',
      };
    }

    throw new UnauthorizedException('Invalid mock Firebase token');
  }
}