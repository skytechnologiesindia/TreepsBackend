import { clientIp, UNKNOWN_IP } from './client-ip.js';

const SOCKET = '203.0.113.9';

describe('clientIp', () => {
  describe('hops = 0 (untrusted)', () => {
    it('uses the socket address', () => {
      expect(clientIp(SOCKET, undefined, 0)).toBe(SOCKET);
    });

    it('ignores X-Forwarded-For completely, however it looks', () => {
      expect(clientIp(SOCKET, '198.51.100.7', 0)).toBe(SOCKET);
      expect(clientIp(SOCKET, '198.51.100.7, 10.0.0.1', 0)).toBe(SOCKET);
      expect(clientIp(SOCKET, ['198.51.100.7'], 0)).toBe(SOCKET);
    });

    it('is the unknown address when there is no socket address', () => {
      expect(clientIp(undefined, '198.51.100.7', 0)).toBe(UNKNOWN_IP);
    });

    it('treats a negative or NaN hop count as untrusted too', () => {
      expect(clientIp(SOCKET, '198.51.100.7', -1)).toBe(SOCKET);
      expect(clientIp(SOCKET, '198.51.100.7', NaN)).toBe(SOCKET);
    });
  });

  describe('hops = 1', () => {
    it('uses the last entry of X-Forwarded-For', () => {
      expect(clientIp('10.0.0.1', '198.51.100.7', 1)).toBe('198.51.100.7');
    });

    it('ignores entries the client wrote on the left', () => {
      expect(clientIp('10.0.0.1', '1.1.1.1, 2.2.2.2, 198.51.100.7', 1)).toBe('198.51.100.7');
    });

    it('falls back to the socket address when the header is missing', () => {
      expect(clientIp('10.0.0.1', undefined, 1)).toBe('10.0.0.1');
    });

    it('falls back to the socket address when the entry is not an IP address', () => {
      expect(clientIp('10.0.0.1', 'not-an-ip', 1)).toBe('10.0.0.1');
      expect(clientIp('10.0.0.1', '198.51.100.7, ', 1)).toBe('10.0.0.1');
      expect(clientIp('10.0.0.1', '', 1)).toBe('10.0.0.1');
    });

    it('trims spaces and joins repeated headers', () => {
      expect(clientIp('10.0.0.1', '  198.51.100.7  ', 1)).toBe('198.51.100.7');
      expect(clientIp('10.0.0.1', ['1.1.1.1', '198.51.100.7'], 1)).toBe('198.51.100.7');
    });
  });

  describe('hops = 2', () => {
    it('uses the second entry from the right', () => {
      expect(clientIp('10.0.0.2', '198.51.100.7, 10.0.0.1', 2)).toBe('198.51.100.7');
      expect(clientIp('10.0.0.2', 'spoof, 198.51.100.7, 10.0.0.1', 2)).toBe('198.51.100.7');
    });

    it('falls back when the header has fewer entries than hops', () => {
      expect(clientIp('10.0.0.2', '198.51.100.7', 2)).toBe('10.0.0.2');
    });
  });

  describe('address forms', () => {
    it('treats an IPv4-mapped IPv6 address as the plain IPv4 address', () => {
      expect(clientIp('::ffff:203.0.113.9', undefined, 0)).toBe('203.0.113.9');
      expect(clientIp('10.0.0.1', '::ffff:198.51.100.7', 1)).toBe('198.51.100.7');
    });

    it('accepts IPv6 and lower-cases it', () => {
      expect(clientIp('::1', undefined, 0)).toBe('::1');
      expect(clientIp('10.0.0.1', '2001:DB8::1', 1)).toBe('2001:db8::1');
    });
  });
});
