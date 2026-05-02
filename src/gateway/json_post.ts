export type JsonGatewayRouteMap = ReadonlyMap<
  string,
  (input: unknown) => unknown | Promise<unknown>
>;

export interface JsonGatewayHandlerOptions {
  readonly provider?: string;
}

export function createJsonGatewayHandler(
  routes: JsonGatewayRouteMap,
  options: JsonGatewayHandlerOptions = {},
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST") {
      return Response.json({ error: "method not allowed" }, { status: 405 });
    }
    const path = trimPath(new URL(request.url).pathname);
    const route = routes.get(path);
    if (!route) {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    try {
      const inputText = await request.text();
      const input = inputText ? decodeJson(JSON.parse(inputText)) : {};
      const result = await route(input);
      return Response.json({ result: encodeJson(result) });
    } catch (error) {
      return Response.json(
        {
          error: error instanceof Error ? error.message : String(error),
          provider: options.provider,
          path,
        },
        { status: 500 },
      );
    }
  };
}

export function requireGatewayMethod<T extends object, K extends keyof T>(
  service: T,
  method: K,
): T[K] {
  const value = service[method];
  if (typeof value !== "function") {
    throw new Error(`gateway method is not configured: ${String(method)}`);
  }
  return value;
}

function encodeJson(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return { $type: "Uint8Array", base64: bytesToBase64(value) };
  }
  if (Array.isArray(value)) return value.map(encodeJson);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, encodeJson(entry)]),
    );
  }
  return value;
}

function decodeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeJson);
  if (isRecord(value)) {
    if (value.$type === "Uint8Array" && typeof value.base64 === "string") {
      return base64ToBytes(value.base64);
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, decodeJson(entry)]),
    );
  }
  return value;
}

function trimPath(pathname: string): string {
  return pathname.replace(/^\/+|\/+$/g, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
