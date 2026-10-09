// Session numbers (decision 174). Constants, not environment variables (decision 139).
export const SESSION_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // sliding: extended on use
export const SESSION_TOUCH_INTERVAL_MS = 60 * 60 * 1000; // a session is rewritten at most once an hour
export const RIDER_ROLE = 'RIDER';
export const DRIVER_ROLE = 'DRIVER';
