// Services ask this for "now" instead of calling new Date(), so a test can set the time and never
// has to sleep. In Express terms: pass the time source in, like you would pass in a db handle.
export type Clock = () => Date;

export const CLOCK = Symbol('CLOCK');

export const systemClock: Clock = () => new Date();
