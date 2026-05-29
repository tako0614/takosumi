/**
 * HTTP serve primitive for the runtime-agent server (Deno implementation).
 *
 * Canonical Deno runtime path: binds the Hono fetch handler through
 * `Deno.serve` exactly as before, returning the bound port and a shutdown
 * handle. The npm build swaps this module for the Node sibling
 * (`serve.node.ts`) via a dnt `mappings` entry in `scripts/build-npm.ts`, so
 * the Deno runtime behaviour is unchanged while the npm package serves over
 * `node:http`. Keep the exported shape identical between the two modules.
 *
 * The runtime-agent package sits upstream of the kernel in the dependency
 * graph, so it cannot route through the kernel `RuntimeAdapter.serveHttp`
 * without inverting the layering; this local primitive is the runtime-agent's
 * own serve boundary.
 */

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
  const server = Deno.serve(
    { port: options.port, hostname: options.hostname, onListen: () => {} },
    handler,
  );
  const addr = server.addr as { port: number };
  return {
    port: addr.port,
    shutdown: () => server.shutdown(),
  };
}
