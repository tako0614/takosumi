/**
 * HTTP serve primitive for the runtime-agent server.
 *
 * Binds the Hono fetch handler through `node:http`, returning the bound port
 * and a shutdown handle. Bun uses the same Node-compatible path.
 *
 * The runtime-agent package sits upstream of the service in the dependency
 * graph, so it cannot route through the service `RuntimeAdapter.serveHttp`
 * without inverting the layering; this local primitive is the runtime-agent's
 * own serve boundary. The fetch-handler <-> `node:http` bridge mirrors the
 * service runtime adapter's Node server
 * (`src/service/shared/runtime/node.ts`).
 */

import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

export type ServeHttpHandler = (
  request: Request,
) => Response | Promise<Response>;

export interface ServeHttpBinding {
  readonly port: number;
  shutdown(): Promise<void>;
}

export function serveHttp(
  handler: ServeHttpHandler,
  options: { readonly port: number; readonly hostname: string },
): ServeHttpBinding {
  return serveHttpNode(handler, options);
}

function serveHttpNode(
  handler: ServeHttpHandler,
  options: { readonly port: number; readonly hostname: string },
): ServeHttpBinding {
  const server: Server = createServer(
    (req: IncomingMessage, res: ServerResponse) => {
      void handleRequestNode(handler, req, res);
    },
  );
  // Bind synchronously so callers reading `.port` after construction observe
  // the chosen port.
  server.listen(options.port, options.hostname);
  return {
    get port(): number {
      const addr = server.address();
      if (addr && typeof addr === "object") return addr.port;
      return options.port;
    },
    shutdown: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

async function handleRequestNode(
  handler: ServeHttpHandler,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = `http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === "string") headers.set(k, v);
    else if (Array.isArray(v)) headers.set(k, v.join(","));
  }
  const method = req.method ?? "GET";
  const body = method !== "GET" && method !== "HEAD"
    ? new ReadableStream<Uint8Array>({
      start(controller) {
        req.on("data", (chunk: Uint8Array) => controller.enqueue(chunk));
        req.on("end", () => controller.close());
        req.on("error", (err: Error) => controller.error(err));
      },
    })
    : null;
  const init: RequestInit & { duplex?: "half" } = { method, headers, body };
  if (body) init.duplex = "half";
  const response = await handler(new Request(url, init));
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) res.write(value);
  }
  res.end();
}
