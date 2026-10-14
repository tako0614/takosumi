/** Bounded upstream HTTP: no redirects, retained tokens, or response diagnostics. */
export async function fetchUpstreamJson(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit = {},
): Promise<{ value: unknown; headers: Headers }> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const operation = (async () => {
    const response = await fetchImpl(url, {
      ...init,
      // Workerd supports manual/follow, and rejects error before HTTP I/O.
      // Manual also prevents credential forwarding to a redirect destination.
      redirect: "manual",
      signal: controller.signal,
    });
    if ((response.status >= 300 && response.status < 400) || !response.ok || response.redirected) {
      await response.body?.cancel().catch(() => {});
      throw new TypeError("upstream request failed");
    }
    const limit = 128 * 1024;
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d+$/u.test(length) || Number(length) > limit)) {
      await response.body?.cancel();
      throw new TypeError("upstream response exceeds limit");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new TypeError("upstream response is empty");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > limit) throw new TypeError("upstream response exceeds limit");
        chunks.push(chunk.value);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return {
      value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown,
      headers: response.headers,
    };
  })();
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new TypeError("upstream request timed out"));
        }, 5000);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export function isUpstreamJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
