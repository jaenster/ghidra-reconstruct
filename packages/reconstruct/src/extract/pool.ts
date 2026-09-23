/**
 * Bounded concurrency for independent read RPCs.
 *
 * The extractors used to walk their requests in FLIGHTS: send N, wait for all N,
 * send the next N. A flight is as slow as its slowest member, so one 64 KB data
 * value or one 60,000-member struct held the other nineteen slots idle. A window
 * keeps `limit` requests outstanding at all times instead.
 *
 * Results come back in INPUT order whatever order the requests completed in, so
 * a caller that applies them in a loop afterwards applies them exactly as the
 * flight version did - the order of the output never depends on the network.
 */
export async function mapWindowed<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  onSettled?: (settled: number, total: number) => void,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const width = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  let next = 0;
  let settled = 0;
  const lane = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
      settled++;
      onSettled?.(settled, items.length);
    }
  };
  await Promise.all(Array.from({ length: width }, lane));
  return results;
}

/** A positive integer from the environment, or the default. */
export function envConcurrency(name: string, fallback: number): number {
  const raw = Number(process.env[name] ?? String(fallback));
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : fallback;
}
