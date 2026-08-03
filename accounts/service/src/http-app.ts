import { Hono } from "hono";
import type {
  JsonWebKeySet,
  OidcDiscoveryDocument,
} from "@takosjp/takosumi-accounts-contract";
import { json, methodNotAllowed } from "./http-helpers.ts";

export interface AccountsHttpAppOptions {
  readonly discovery: OidcDiscoveryDocument;
  readonly jwks: JsonWebKeySet;
  /**
   * Temporary boundary for route families that have not moved to Hono yet.
   * This is an in-process handoff, not another fetch transport.
   */
  readonly legacyFallback: (request: Request) => Response | Promise<Response>;
}

/**
 * Build the Accounts HTTP shell. The exact public discovery routes are native
 * Hono routes; every other route is explicitly handed to the legacy family
 * until a later migration stage moves it here.
 */
export function createAccountsHttpApp(
  options: AccountsHttpAppOptions,
): Hono {
  const app = new Hono();

  mountJsonGetHeadRoute(app, "/healthz", {
    ok: true,
    service: "takosumi-accounts",
  });
  mountJsonGetHeadRoute(
    app,
    "/.well-known/openid-configuration",
    options.discovery,
  );
  mountJsonGetHeadRoute(app, "/oauth/jwks", options.jwks);

  // Explicit temporary seam for unmigrated route families. Keep this as the
  // final registration so the exact Hono routes above always win.
  app.all("*", (c) => options.legacyFallback(c.req.raw));

  // The legacy handler's public adapter owns its existing error conversion
  // and throw behavior. Do not let Hono replace it with the default 500 page.
  app.onError((error) => {
    throw error;
  });

  return app;
}

function mountJsonGetHeadRoute(
  app: Hono,
  path: string,
  body: unknown,
): void {
  app.all(path, (c) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      return methodNotAllowed("GET, HEAD");
    }
    return json(body);
  });
}
