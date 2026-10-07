// Which unique index a Prisma P2002 error is about, or undefined if it is not a unique violation on
// a column this returns. Prisma 7 with the pg adapter names the index in
// meta.driverAdapterError.cause.constraint.index (for example "Rider_phoneNumber_key", checked
// against real Postgres); older clients list the columns in meta.target.
export function violatedUniqueIndex(error: unknown): 'email' | 'phoneNumber' | undefined {
  const e = error as { code?: string; meta?: { driverAdapterError?: { cause?: { constraint?: { index?: string } } }; target?: unknown } };
  if (e?.code !== 'P2002') return undefined;
  const named = e.meta?.driverAdapterError?.cause?.constraint?.index ?? String(e.meta?.target ?? '');
  if (named.includes('email')) return 'email';
  if (named.includes('phoneNumber')) return 'phoneNumber';
  return undefined;
}
