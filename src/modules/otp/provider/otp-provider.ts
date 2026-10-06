// What the app needs from an SMS provider. An interface is a TypeScript contract: in Express terms,
// the shape of a service object that a real client and a fake one both follow, so the route code
// never knows which one it is talking to. Any provider failure (timeout, refusal, unreadable reply)
// is a thrown error; the caller turns it into OTP_PROVIDER_ERROR.
export interface OtpProvider {
  // Asks the provider to send an OTP to the phone. Returns the provider's session id, which stays
  // on the server and is never sent to the app.
  send(phoneNumber: string): Promise<{ providerSessionId: string }>;
  // Asks the provider if the code matches that session: true or false.
  verify(providerSessionId: string, otp: string): Promise<boolean>;
}

// The token Nest uses to find the chosen provider (an interface has no runtime value to inject by).
export const OTP_PROVIDER = Symbol('OTP_PROVIDER');
