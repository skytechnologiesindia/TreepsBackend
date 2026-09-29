export const ERROR_REGISTRY = {
  INVALID_INPUT: { status: 400, message: 'Please check your input.' },
  UNAUTHORIZED: { status: 401, message: 'Please log in again.' },
  FORBIDDEN: { status: 403, message: "You don't have access to this." },
  NOT_FOUND: { status: 404, message: "We couldn't find that." },
  CONFLICT: {
    status: 409,
    message: "This can't be done right now. Please refresh and try again.",
  },
  RATE_LIMITED: { status: 429, message: 'Too many requests. Try again shortly.' },
  INTERNAL_ERROR: { status: 500, message: 'Something went wrong. Please try again.' },
  OUT_OF_SERVICE_AREA: { status: 422, message: "We don't serve this area yet." },
  PICKUP_DROP_TOO_CLOSE: { status: 422, message: 'Pickup and drop are too close.' },
  TRIP_TOO_LONG: { status: 422, message: 'This trip is too long for now.' },
  ROUTE_UNAVAILABLE: { status: 422, message: "We couldn't plan this route. Try again." },
  PAYMENT_DUE: { status: 403, message: 'Please clear your pending payment first.' },
  ACCOUNT_BANNED: { status: 403, message: "This account can't book rides." },
} as const satisfies Record<string, { status: number; message: string }>;

export type ErrorCode = keyof typeof ERROR_REGISTRY;
