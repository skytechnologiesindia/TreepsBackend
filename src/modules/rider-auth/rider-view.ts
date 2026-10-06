import type { Rider } from '@prisma/client';

// The rider object in replies (docs/api/rider-register.md, Response fields). Only these fields:
// never deletedAt, lastLoginAt or any internal value. Dates are ISO UTC.
export function riderView(rider: Rider) {
  return {
    id: rider.id,
    fullName: rider.fullName,
    phoneNumber: rider.phoneNumber,
    email: rider.email,
    registeredCity: rider.registeredCity,
    registeredState: rider.registeredState,
    status: rider.status,
    isPhoneVerified: rider.isPhoneVerified,
    isEmailVerified: rider.isEmailVerified,
    isProfileComplete: rider.isProfileComplete,
    createdAt: rider.createdAt.toISOString(),
  };
}

export type RiderView = ReturnType<typeof riderView>;
