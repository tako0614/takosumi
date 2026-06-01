/**
 * HTTP serve primitive for the runtime-agent server (runtime-detecting).
 *
 * Binds the Hono fetch handler through `Deno.serve` on Deno and through
 * `node:http` on Node, returning the bound port and a shutdown handle and
 * selecting the path at call time. No build-time module mapping is required.
 *
 * Runtime detection: {@link denoServe} returns the genuine `Deno.serve`
 * function only when it is actually a function, so Node / Bun / Workers select
 * the Node path instead of mistaking a partial `globalThis.Deno` shape for real
 * Deno. The Deno API is reached through `globalThis.Deno` (not a bare
 * `declare const Deno` identifier) so the emitted npm code contains no unbound
 * `Deno.serve` reference.
 *
 * The runtime-agent package sits upstream of the kernel in the dependency
 * graph, so it cannot route through the kernel `RuntimeAdapter.serveHttp`
 * without inverting the layering; this local primitive is the runtime-agent's
 * own serve boundary. The fetch-handler <-> `node:http` bridge mirrors the
 * kernel runtime adapter's Node server
 * (`src/kernel/shared/runtime/node.ts`).
 */

import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

type DenoServe = (
  options: {
    port?: number;
    hostname?: string;
    onListen?: () => void;
  },
  handler: ServeHttpHandler,
) => {
  addr: { port: number };
  shutdown(): Promise<void>;
};

export type ServeHttpHandler = (
  request: Request,
) => Response | Promise<Response>;

export interface ServeHttpBinding {
  readonly port: number;
  shutdown(): Promise<void>;
}

/**
 * The genuine `Deno.serve` function, or `undefined` on Node / Bun / Workers /
 * partial compatibility globals that do not implement `serve`. Reached through
 * `globalThis` so the npm build emits no unbound `Deno` identifier. Probing
 * `Deno.serve === "function"` (a function only on real Deno) is the reliable
 * discriminator. It does NOT also gate on Node being absent — Deno 2.x exposes
 * a Node-compat `process.versions.node`, so such a clause would reject real
 * Deno.
 */
function denoServe(): DenoServe | undefined {
  const deno = (globalThis as { Deno?: { serve?: unknown } }).Deno;
  if (typeof deno?.serve === "function") {
    return deno.serve as DenoServe;
  }
  return undefined;
}

export function serveHttp(
  handler: ServeHttpHandler,
  options: { readonly port: number; readonly hostname: string },
): ServeHttpBinding {
  const serve = denoServe();
  return serve
    ? serveHttpDeno(serve, handler, options)
    : serveHttpNode(handler, options);
}

function serveHttpDeno(
  serve: DenoServe,
  handler: ServeHttpHandler,
  options: { readonly port: number; readonly hostname: string },
): ServeHttpBinding {
  const server = serve(
    { port: options.port, hostname: options.hostname, onListen: () => {} },
    handler,
  );
  const addr = server.addr as { port: number };
  return {
    port: addr.port,
    shutdown: () => server.shutdown(),
  };
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
  // the chosen port (matching the Deno implementation's `server.addr.port`).
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
