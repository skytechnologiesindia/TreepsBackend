import { isIP } from 'node:net';

export const UNKNOWN_IP = 'unknown';

// "::ffff:1.2.3.4" and "1.2.3.4" are the same client.
function normalize(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let value = raw.trim();
  if (value.toLowerCase().startsWith('::ffff:') && isIP(value.slice(7)) === 4) {
    value = value.slice(7);
  }
  return isIP(value) ? value.toLowerCase() : undefined;
}

// hops = 0 (the default, "untrusted"): the connection's own address; a forwarded header is never
// read, because the client can write anything in it.
// hops = N > 0: N trusted proxies each add the address they received the request from to the
// right end of X-Forwarded-For, so the client is the Nth entry from the right. Entries to its
// left were written by the client and are ignored. A header with fewer than N entries, or an
// entry that is not an IP address, is not trusted: the connection's own address is used.
export function clientIp(
  socketAddress: string | undefined,
  forwardedFor: string | string[] | undefined,
  hops: number,
): string {
  const direct = normalize(socketAddress) ?? UNKNOWN_IP;
  if (!(hops > 0) || forwardedFor === undefined) return direct;
  const header = Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor;
  const parts = header.split(',').map((part) => part.trim());
  if (parts.length < hops) return direct;
  return normalize(parts[parts.length - hops]) ?? direct;
}
