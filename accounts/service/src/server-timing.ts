export interface ServerTimingMetric {
  readonly name: string;
  readonly durationMs: number;
}

export type ServerTimingBucket = ServerTimingMetric[] | undefined;

export function serverTimingBucketForPath(
  pathname: string,
): ServerTimingMetric[] | undefined {
  return pathname.startsWith("/api/v1/") ? [] : undefined;
}

export async function measureServerTiming<T>(
  bucket: ServerTimingBucket,
  name: string,
  task: () => T | Promise<T>,
): Promise<T> {
  if (!bucket) return await task();
  const startedAt = nowMs();
  try {
    return await task();
  } finally {
    bucket.push({ name, durationMs: nowMs() - startedAt });
  }
}

export function appendServerTiming(
  response: Response,
  bucket: ServerTimingBucket,
): Response {
  if (!bucket || bucket.length === 0) return response;
  const headers = new Headers(response.headers);
  const existing = headers.get("Server-Timing");
  const value = bucket.map(formatServerTimingMetric).join(", ");
  headers.set("Server-Timing", existing ? `${existing}, ${value}` : value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function formatServerTimingMetric(metric: ServerTimingMetric): string {
  const durationMs = Math.max(0, metric.durationMs);
  return `${metric.name};dur=${durationMs.toFixed(1)}`;
}

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}
