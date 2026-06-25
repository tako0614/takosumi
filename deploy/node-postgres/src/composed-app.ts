/**
 * Composed Takosumi reference app (Bun + Postgres profile).
 *
 * This is the single Hono app this operator distribution serves from one
 * cloud URL. It EMBEDS the Takosumi service via `createTakosumiService` from the
 * local Takosumi service framework (the framework never self-serves — serving and
 * route extension are this composer's job), then extends that one app with the
 * Takosumi Accounts surfaces (dashboard, billing, OIDC issuer, install UI).
 *
 * Wiring summary:
 *  - `createTakosumiService` returns the Takosumi Hono `app` (OpenTofu
 *    plan/apply/destroy API + service API) plus the in-process operations
 *    facade.
 *  - The Bun + Postgres profile provides the durable SQL ledger. OpenTofu
 *    execution is supplied by the operator runner profile / runner process.
 *  - The Takosumi Accounts handler — which already serves the dashboard, billing,
 *    OIDC, and install UI routes as one fetch handler — is mounted on the same
 *    app as a fallback so the composed app answers the account-plane surfaces
 *    that the Takosumi service deploy control routes do not claim.
 */
import type {
  AccountsHandler,
  DeployControlFacadeOptions,
} from "@takosjp/takosumi-accounts-service";
import {
  createTakosumiService,
  type CreatedTakosumiService,
} from "../../../core/bootstrap.ts";
import { selectSecretBoundaryCrypto } from "../../../core/adapters/secret-store/memory.ts";
import { TAKOSUMI_ACCOUNTS_INSTALLATIONS_PATH } from "@takosjp/takosumi-accounts-contract";
import { Hono } from "hono";
import type { PostgresAccountsStore } from "@takosjp/takosumi-accounts-service";
import type { NodeAccountsServerConfig } from "./handler.ts";
import { createStaticAssetResponder } from "./static-assets.ts";

export interface ComposedAppInput {
  readonly config: NodeAccountsServerConfig;
  readonly store: PostgresAccountsStore;
  /**
   * The already-built Takosumi Accounts fetch handler. Tests and external
   * composers can still provide this directly.
   */
  readonly accountsHandler?: AccountsHandler;
  /**
   * Preferred production wiring: build the accounts handler after the embedded
   * Takosumi service exists so the account-plane DeployControl facade can use
   * the in-process typed operations facade instead of falling back to direct
   * ledger mutations, and so the dashboard `/api/v1/*` control surface can use
   * the full typed operations facade.
   */
  readonly createAccountsHandler?: (
    deployControl: DeployControlFacadeOptions,
    controlPlaneOperations: CreatedTakosumiService["operations"],
  ) => AccountsHandler | Promise<AccountsHandler>;
  /**
   * Optional runtime env forwarded into the embedded Takosumi service. The composer
   * ensures an internal deploy control bearer is present so the in-process Accounts
   * facade can reach the Takosumi Deploy Control API even when the operator did not
   * expose a public deploy control token.
   */
  readonly runtimeEnv?: CreateTakosumiServiceArg["runtimeEnv"];
  /**
   * Optional SQL client backing the Takosumi Deploy Control API ledger so
   * Capsule / Run / StateVersion / Output records survive restarts. When omitted the
   * service falls back to its in-memory ledger (fine for dev / local-substrate).
   */
  readonly sqlClient?: CreateTakosumiServiceArg["sqlClient"];
  /**
   * Optional OpenTofu runner injected by an operator composition. The generic
   * reference server leaves this absent; local-substrate wires a local runner
   * so the browser/CLI smoke can exercise real upload -> plan -> apply.
   */
  readonly opentofuRunner?: CreateTakosumiServiceArg["opentofuRunner"];
  readonly writeSourceArchive?: CreateTakosumiServiceArg["writeSourceArchive"];
  readonly runnerProfiles?: CreateTakosumiServiceArg["runnerProfiles"];
  readonly defaultRunnerProfileId?: CreateTakosumiServiceArg["defaultRunnerProfileId"];
  /**
   * Native adapter implementation bindings (Docker Compose / systemd / etc.) attached to the
   * embedded Takosumi service. The reference Bun profile ships none by default; the
   * substrate-redesign composer wiring forwards operator-supplied bindings into
   * the embedded service.
   */
  readonly implementations?: CreateTakosumiServiceArg["implementations"];
  /**
   * Extra request handling that must run before the embedded Takosumi app and
   * the accounts fallback (e.g. `/healthz`, signed export downloads). Returns
   * a `Response` to short-circuit, or `undefined` to fall through.
   */
  readonly preHandle?: (req: Request) => Promise<Response | undefined>;
  /**
   * Filesystem directory of the built dashboard SPA
   * (`dashboard/dist`). When set, non-API GET/HEAD requests are served from
   * here with an `index.html` SPA fallback, mirroring the Cloudflare Workers
   * Static Assets profile. Resolved by `resolveStaticAssetsDir` in `server.ts`;
   * omitted (no static serving) when no SPA build is present.
   */
  readonly staticAssets?: string;
}

type CreateTakosumiServiceArg = NonNullable<
  Parameters<typeof createTakosumiService>[0]
>;

/**
 * Build the one composed Hono app this distribution serves. Returns an outer
 * `app` that forwards the account-plane `/v1/installation-projections/*`
 * projection surface to the accounts handler, delegates the primary
 * `/api/v1/*` deploy-control surface to the embedded service app, and exposes
 * the in-process `operations` facade.
 */
export async function buildComposedApp(
  input: ComposedAppInput,
): Promise<CreatedTakosumiService> {
  const { runtimeEnv } = embeddedServiceRuntimeEnv(input.runtimeEnv);
  const secretCrypto = selectSecretBoundaryCrypto({ env: runtimeEnv });
  const created = await createTakosumiService({
    // Operators add native adapter implementation bindings (Docker Compose / systemd / etc.)
    // here; the reference Bun profile ships none by default but forwards
    // whatever the caller supplies.
    implementations: input.implementations ?? [],
    runtimeEnv,
    mountInternalLedgerRoutes: true,
    ...(input.sqlClient ? { sqlClient: input.sqlClient } : {}),
    ...(input.opentofuRunner ? { opentofuRunner: input.opentofuRunner } : {}),
    ...(input.writeSourceArchive
      ? { writeSourceArchive: input.writeSourceArchive }
      : {}),
    ...(input.runnerProfiles ? { runnerProfiles: input.runnerProfiles } : {}),
    ...(input.defaultRunnerProfileId
      ? { defaultRunnerProfileId: input.defaultRunnerProfileId }
      : {}),
    secretCrypto,
  });

  const serviceApp = created.app;
  // Account-plane fallback INSIDE the embedded Takosumi service app. The Takosumi Accounts
  // handler is one fetch handler that internally routes the dashboard, billing,
  // OIDC, and install UI paths; `app.route('/dashboard', …)` would split that
  // single handler, so we mount it as the catch-all the service app does not
  // claim. This reaches non-installation account-plane surfaces (dashboard /
  // billing / OIDC / install UI) that the service never registers.
  let accountsHandler = input.accountsHandler;
  serviceApp.all("*", async (c) => {
    if (!accountsHandler) {
      return new Response("accounts handler is not initialized", {
        status: 503,
      });
    }
    return await accountsHandler(c.req.raw);
  });

  const deployControl = inProcessDeployControlFacade(created.operations);
  accountsHandler ??= input.createAccountsHandler
    ? await input.createAccountsHandler(deployControl, created.operations)
    : undefined;
  if (!accountsHandler) {
    throw new TypeError(
      "buildComposedApp requires accountsHandler or createAccountsHandler",
    );
  }
  const mountedAccountsHandler = accountsHandler;

  // Mount the accounts projection route on the outer app before the embedded
  // service fallback. Projection create/revision operations are wired with the
  // in-process DeployControl facade, so they cannot bypass the canonical
  // Capsule / Run ledger even though the account plane owns identity,
  // billing, export, and service-token projections.
  const app = new Hono();
  if (input.preHandle) {
    app.use("*", async (c, next) => {
      const short = await input.preHandle?.(c.req.raw);
      if (short) return short;
      await next();
    });
  }
  // Serve the dashboard SPA for non-API navigations (after preHandle's
  // /healthz + export downloads, before the API routes). API namespaces are
  // skipped inside the responder so the service / accounts handlers keep
  // owning them; `/dashboard/*` falls through to the SPA (legacy server-HTML
  // dashboard retired). Mirrors the Cloudflare Static Assets profile.
  if (input.staticAssets) {
    const serveStatic = createStaticAssetResponder(input.staticAssets);
    app.use("*", async (c, next) => {
      const asset = await serveStatic(c.req.raw);
      if (asset) return asset;
      await next();
    });
  }
  app.all(TAKOSUMI_ACCOUNTS_INSTALLATIONS_PATH, (c) =>
    mountedAccountsHandler(c.req.raw),
  );
  app.all(`${TAKOSUMI_ACCOUNTS_INSTALLATIONS_PATH}/*`, (c) =>
    mountedAccountsHandler(c.req.raw),
  );
  app.all("*", (c) => serviceApp.fetch(c.req.raw));

  // The dev seam may resolve Hono's type from the sibling framework checkout
  // while this composer imports Hono from its own node_modules. Runtime Hono
  // objects are compatible; keep the cast at the framework/composer boundary.
  return { ...created, app: app as unknown as CreatedTakosumiService["app"] };
}

function inProcessDeployControlFacade(
  operations: CreatedTakosumiService["operations"],
): DeployControlFacadeOptions {
  // The facade calls the embedded service's typed `operations` facade directly
  // (no Bearer handshake, no JSON round-trip). This is the only transport —
  // the account-plane deploy-control seam is in-process only (per AGENTS.md).
  return { operations };
}

function embeddedServiceRuntimeEnv(
  configured: CreateTakosumiServiceArg["runtimeEnv"] | undefined,
): {
  readonly runtimeEnv: Record<string, string | undefined>;
  readonly deployControlToken: string;
} {
  const runtimeEnv: Record<string, string | undefined> = {
    ...((
      globalThis as {
        process?: { env?: Record<string, string | undefined> };
      }
    ).process?.env ?? {}),
    ...(configured ?? {}),
  };
  const deployControlToken =
    nonEmpty(runtimeEnv.TAKOSUMI_DEPLOY_CONTROL_TOKEN) ??
    `embedded-${crypto.randomUUID()}`;
  return {
    runtimeEnv: {
      ...runtimeEnv,
      TAKOSUMI_DEPLOY_CONTROL_TOKEN: deployControlToken,
    },
    deployControlToken,
  };
}

function nonEmpty(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}
