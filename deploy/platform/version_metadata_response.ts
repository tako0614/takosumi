const WORKER_VERSION_ID =
  /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;

export interface PlatformWorkerVersionMetadata {
  readonly id?: unknown;
}

/**
 * Bind one ordinary HTTP response to the immutable Worker Version that served
 * it. Cloudflare supplies the identity through the version-metadata binding;
 * callers cannot select it. Missing or malformed metadata is deliberately not
 * replaced with a synthetic value, so production readback fails closed.
 */
export function withPlatformWorkerVersion(
  response: Response,
  metadata: PlatformWorkerVersionMetadata | undefined,
): Response {
  const versionId = metadata?.id;
  if (typeof versionId !== "string" || !WORKER_VERSION_ID.test(versionId)) {
    return response;
  }

  const runtimeResponse = response as Response & {
    readonly cf?: unknown;
    readonly webSocket?: unknown;
  };
  if (response.status === 101 || runtimeResponse.webSocket !== undefined) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.set("x-takosumi-version-id", versionId);
  const init = {
    status: response.status,
    statusText: response.statusText,
    headers,
    ...(runtimeResponse.cf !== undefined ? { cf: runtimeResponse.cf } : {}),
  };
  return new Response(response.body, init);
}
