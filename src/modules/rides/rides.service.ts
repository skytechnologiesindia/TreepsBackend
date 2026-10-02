import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { EstimateDto } from './dto/estimate.dto.js';

// FAKE L0 fares in paise (11100 paise = Rs 111). Not rates: nothing is calculated.
const FAKE_FARE_PAISE = { MINI: 11100, SEDAN: 22200, XL: 33300 };

function fakeTier(fareAmount: number, seatCapacity: number) {
  return {
    isAvailable: true, // FAKE
    etaMinutes: 5, // FAKE
    message: '', // FAKE
    fareAmount,
    currency: 'INR',
    seatCapacity, // FAKE
    breakdown: {
      baseFare: fareAmount, // FAKE
      distanceCharge: 0, // FAKE
      timeCharge: 0, // FAKE
      minimumFareAdjustment: 0, // FAKE
      tax: 0, // FAKE
      roundingAdjustment: 0, // FAKE
    },
  };
}

@Injectable()
export class RidesService {
  estimate(dto: EstimateDto) {
    return {
      quoteId: randomUUID(),
      expiresInSeconds: 180, // FAKE
      distanceMeters: 5000, // FAKE
      durationSeconds: 900, // FAKE
      pickupAddress: dto.pickupAddress,
      dropAddress: dto.dropAddress,
      tiers: {
        MINI: fakeTier(FAKE_FARE_PAISE.MINI, 4), // FAKE
        SEDAN: fakeTier(FAKE_FARE_PAISE.SEDAN, 4), // FAKE
        XL: fakeTier(FAKE_FARE_PAISE.XL, 6), // FAKE
      },
    };
  }
}
