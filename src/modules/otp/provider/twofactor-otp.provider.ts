import { Logger } from '@nestjs/common';
import { OTP_PROVIDER_TIMEOUT_MS } from '../../../config/otp.js';
import type { OtpProvider } from './otp-provider.js';

const BASE_URL = 'https://2factor.in/API/V1';
const INDIAN_MOBILE = /^\+91([6-9][0-9]{9})$/;

// Why a call failed. Fixed words only: nothing from the network, the URL or the reply goes into
// an error or a log line, because the API key is part of the URL.
export type OtpProviderFailure =
  | 'BAD_PHONE'
  | 'NETWORK_OR_TIMEOUT'
  | 'BAD_REPLY'
  | 'PROVIDER_REFUSED';

// In Express terms: a custom error class. The callers catch any provider error and answer
// 503 OTP_PROVIDER_ERROR. The message is built only from the fixed reason above.
export class OtpProviderError extends Error {
  constructor(readonly reason: OtpProviderFailure) {
    super(`OTP provider call failed (${reason})`);
    this.name = 'OtpProviderError';
  }
}

export interface TwoFactorOptions {
  apiKey: string;
  template: string;
  fetchFn?: typeof fetch; // tests pass a mock; production uses the global fetch
  timeoutMs?: number;
  log?: (line: string) => void;
}

// Real SMS provider. 2Factor generates the code and keeps it; we only keep the session id.
// No retry: one attempt, 5 second limit, any problem is an OtpProviderError.
export class TwoFactorOtpProvider implements OtpProvider {
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly log: (line: string) => void;
  private readonly apiKey: string;
  private readonly template: string;

  constructor(options: TwoFactorOptions) {
    this.apiKey = options.apiKey;
    this.template = options.template;
    this.fetchFn = options.fetchFn ?? fetch;
    this.timeoutMs = options.timeoutMs ?? OTP_PROVIDER_TIMEOUT_MS;
    const logger = new Logger('TwoFactorOtpProvider');
    this.log = options.log ?? ((line) => logger.warn(line));
  }

  async send(phoneNumber: string): Promise<{ providerSessionId: string }> {
    const match = INDIAN_MOBILE.exec(phoneNumber);
    if (!match) throw this.fail('send', 'BAD_PHONE');
    // 2Factor takes the number with the country code and no "+": 91XXXXXXXXXX.
    const body = await this.call('send', `SMS/91${match[1]}/AUTOGEN/${encodeURIComponent(this.template)}`);
    if (body.Status !== 'Success' || typeof body.Details !== 'string' || body.Details === '') {
      throw this.fail('send', 'PROVIDER_REFUSED');
    }
    return { providerSessionId: body.Details };
  }

  async verify(providerSessionId: string, otp: string): Promise<boolean> {
    const body = await this.call(
      'verify',
      `SMS/VERIFY/${encodeURIComponent(providerSessionId)}/${encodeURIComponent(otp)}`,
    );
    if (body.Status === 'Success' && body.Details === 'OTP Matched') return true;
    // A wrong or expired code is a normal answer, not a provider failure.
    if (body.Status === 'Error' && (body.Details === 'OTP Mismatch' || body.Details === 'OTP Expired')) {
      return false;
    }
    throw this.fail('verify', 'PROVIDER_REFUSED');
  }

  private async call(op: 'send' | 'verify', path: string): Promise<{ Status?: unknown; Details?: unknown }> {
    let parsed: unknown;
    try {
      const res = await this.fetchFn(`${BASE_URL}/${encodeURIComponent(this.apiKey)}/${path}`, {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      parsed = await res.json(); // 2Factor reports a wrong code with an error Status, so the HTTP code is not trusted
    } catch (error) {
      // The original error is dropped on purpose: it can carry the URL.
      const isJson = error instanceof SyntaxError;
      throw this.fail(op, isJson ? 'BAD_REPLY' : 'NETWORK_OR_TIMEOUT');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw this.fail(op, 'BAD_REPLY');
    }
    return parsed as { Status?: unknown; Details?: unknown };
  }

  private fail(op: string, reason: OtpProviderFailure): OtpProviderError {
    this.log(`2Factor ${op} failed: ${reason}`);
    return new OtpProviderError(reason);
  }
}
