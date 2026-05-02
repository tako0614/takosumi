export interface RemoteCallOptions {
  readonly url: string;
  readonly token?: string;
  readonly path: string;
  readonly method?: string;
  readonly body?: unknown;
}

export async function callKernel(
  options: RemoteCallOptions,
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (options.token) headers["authorization"] = `Bearer ${options.token}`;
  const response = await fetch(`${options.url.replace(/\/$/, "")}${options.path}`, {
    method: options.method ?? "POST",
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  let body: unknown = undefined;
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    body = await response.json();
  } else {
    body = await response.text();
  }
  return { status: response.status, body };
}
