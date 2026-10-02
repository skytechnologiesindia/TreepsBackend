import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { setupApp } from '../../common/setup-app.js';
import { versionedBaseUrl } from '../../common/testing/base-url.js';
import { RidesController } from './rides.controller.js';
import { RidesService } from './rides.service.js';

const validBody = {
  pickupLat: 23.3,
  pickupLng: 85.3,
  dropLat: 23.4,
  dropLng: 85.4,
  pickupAddress: 'Test pickup',
  dropAddress: 'Test drop',
};

describe('POST /v1/rides/estimate (L0, FAKE values)', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [RidesController],
      providers: [RidesService],
    }).compile();
    app = moduleRef.createNestApplication();
    setupApp(app);
    await app.listen(0, '127.0.0.1');
    baseUrl = versionedBaseUrl(app);
  });

  afterAll(async () => {
    await app.close();
  });

  async function post(body: unknown) {
    const res = await fetch(`${baseUrl}/rides/estimate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { res, body: await res.json() };
  }

  // Good request: answers 200 (not 201) in the { success, data, requestId } envelope.
  it('replies 200 with the standard envelope for a valid request', async () => {
    const { res, body } = await post(validBody);
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
  });

  // The reply holds the FAKE L0 values. When real fares replace them, change these checks on purpose.
  it('returns the FAKE fixed values', async () => {
    const { body } = await post(validBody);
    expect(body.data.expiresInSeconds).toBe(180);
    expect(body.data.tiers.MINI.fareAmount).toBe(11100);
    expect(body.data.tiers.SEDAN.fareAmount).toBe(22200);
    expect(body.data.tiers.XL.fareAmount).toBe(33300);
  });

  // The six breakdown lines of each tier must add up to its fareAmount.
  // Wrong example: baseFare 11100 plus tax 5 would add up to 11105.
  it('breakdown lines add up to fareAmount for every tier', async () => {
    const { body } = await post(validBody);
    for (const tier of Object.values<any>(body.data.tiers)) {
      const sum = Object.values<number>(tier.breakdown).reduce(
        (a, b) => a + b,
        0,
      );
      expect(sum).toBe(tier.fareAmount);
    }
  });

  // A required field is absent. Wrong example: the body has no dropLat.
  it('rejects a missing field with INVALID_INPUT', async () => {
    const { res, body } = await post({ ...validBody, dropLat: undefined });
    expect(res.status).toBe(400);
    expect(body.error.code).toBe('INVALID_INPUT');
    expect(body.error.details).toEqual([
      { field: 'dropLat', reason: 'REQUIRED' },
    ]);
  });

  // A number sent as text. Wrong example: pickupLat is "23.3" in quotes, not 23.3.
  it('rejects a wrong type with WRONG_TYPE', async () => {
    const { res, body } = await post({ ...validBody, pickupLat: '23.3' });
    expect(res.status).toBe(400);
    expect(body.error.details).toEqual([
      { field: 'pickupLat', reason: 'WRONG_TYPE' },
    ]);
  });

  // A degree past the edge of the map. Wrong example: dropLng is 181 (the limit is 180).
  it('rejects a longitude above 180 with OUT_OF_RANGE', async () => {
    const { res, body } = await post({ ...validBody, dropLng: 181 });
    expect(res.status).toBe(400);
    expect(body.error.details).toEqual([
      { field: 'dropLng', reason: 'OUT_OF_RANGE' },
    ]);
  });

  // An address that is present but empty. Wrong example: pickupAddress is "".
  it('rejects an empty address with REQUIRED', async () => {
    const { res, body } = await post({ ...validBody, pickupAddress: '' });
    expect(res.status).toBe(400);
    expect(body.error.details).toEqual([
      { field: 'pickupAddress', reason: 'REQUIRED' },
    ]);
  });

  // An address over the 200-character L0 limit. Wrong example: dropAddress of 201 letters.
  it('rejects an address of 201 characters with TOO_LONG', async () => {
    const { res, body } = await post({
      ...validBody,
      dropAddress: 'a'.repeat(201),
    });
    expect(res.status).toBe(400);
    expect(body.error.details).toEqual([
      { field: 'dropAddress', reason: 'TOO_LONG' },
    ]);
  });

  // The client must never set a price. Wrong example: the body also carries fareAmount: 1.
  it('rejects a client-sent fareAmount as an UNKNOWN_FIELD', async () => {
    const { res, body } = await post({ ...validBody, fareAmount: 1 });
    expect(res.status).toBe(400);
    expect(body.error.details).toEqual([
      { field: 'fareAmount', reason: 'UNKNOWN_FIELD' },
    ]);
  });
});
