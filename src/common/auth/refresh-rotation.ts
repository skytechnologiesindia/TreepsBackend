import { REFRESH_REUSE_GRACE_MS } from '../../config/tokens.js';

// What a presented refresh token turns out to be. Pure, so the driver now and the rider later share
// the same rule (decision 171). A rotated token keeps its row with revokedAt = the time it was
// rotated, which is all reuse detection needs: no extra column.
export type PresentedRefreshToken =
  | 'USABLE' // never rotated, not expired
  | 'EXPIRED' // 30 days passed
  | 'ROTATED_RECENTLY' // already rotated, within the grace window: an app retry or double-fire
  | 'REUSED'; // already rotated, older than the grace window: treat as theft

export function classifyRefreshToken(row: { expiresAt: Date; revokedAt: Date | null }, now: Date): PresentedRefreshToken {
  if (row.revokedAt !== null) {
    return now.getTime() - row.revokedAt.getTime() > REFRESH_REUSE_GRACE_MS ? 'REUSED' : 'ROTATED_RECENTLY';
  }
  return row.expiresAt.getTime() <= now.getTime() ? 'EXPIRED' : 'USABLE';
}
