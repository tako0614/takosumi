/**
 * Tiny `fetch` mock helper for connector tests. Returns a fake `fetch`
 * implementation that records each call and replies via the supplied
 * responder. Each call is captured along with its URL, method, headers, and
 * body text (decoded as UTF-8).
 */

export interface CapturedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body?: string;
}

export interface RecordingFetch {
  readonly fetch: typeof fetch;
  readonly calls: readonly CapturedRequest[];
}

export function recordingFetch(
  responder: (req: CapturedRequest) => Response | Promise<Response>,
): RecordingFetch {
  const calls: CapturedRequest[] = [];
  const fakeFetch = ((
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" || input instanceof URL
      ? `${input}`
      : input.url;
    const initRecord = (init ?? {}) as Record<string, unknown>;
    const method = String(initRecord.method ?? "GET").toUpperCase();
    const headers = new Headers(
      (initRecord.headers as HeadersInit | undefined) ?? {},
    );
    let bodyText: string | undefined;
    const rawBody = initRecord.body;
    if (rawBody !== undefined && rawBody !== null) {
      if (typeof rawBody === "string") bodyText = rawBody;
      else if (rawBody instanceof Uint8Array) {
        bodyText = new TextDecoder().decode(rawBody);
      } else if (rawBody instanceof ArrayBuffer) {
        bodyText = new TextDecoder().decode(new Uint8Array(rawBody));
      }
    }
    const captured: CapturedRequest = { url, method, headers, body: bodyText };
    calls.push(captured);
    return Promise.resolve(responder(captured));
  }) as typeof fetch;
  return { fetch: fakeFetch, calls };
}
