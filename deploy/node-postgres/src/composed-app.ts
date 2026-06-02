/**
 * Composed Takosumi reference app (Bun + Postgres profile).
 *
 * This is the single Hono app this operator distribution serves from one
 * cloud URL. It EMBEDS the Takosumi service via `createTakosumiService` from the
 * `@takosjp/takosumi` framework (the framework never self-serves — serving and
 * route extension are this composer's job), then extends that one app with the
 * Takosumi Accounts surfaces (dashboard, billing, OIDC issuer, install UI).
 *
 * Wiring summary:
 *  - `createTakosumiService` returns the Takosumi Hono `app` (the 5-endpoint
 *    Installer API + service API) plus the in-process operations facade.
 *  - The Bun + Postgres profile injects the default runtime git/tar runners
 *    through the service `RuntimeAdapter`, so git + prepared-tar source both
 *    work here, unlike the Workers profile.
 *  - Takosumi's workload platform service resolver is attached as
 *    `platformServices` so install / deploy binding selections can resolve
 *    Cloud-managed OIDC and billing PlatformServices.
 *  - The Takosumi Accounts handler — which already serves the dashboard, billing,
 *    OIDC, and install UI routes as one fetch handler — is mounted on the same
 *    app as a fallback so the composed app answers the account-plane surfaces
 *    that the Takosumi service installer routes do not claim.
 */
import type {
  AccountsHandler,
  InstallerProxyOptions,
} from "@takosjp/takosumi-accounts-service";
import { createTakosumiService } from "@takosjp/takosumi";
import type { CreatedTakosumiService } from "@takosjp/takosumi";
import { Hono } from "hono";
import { createTakosumiWorkloadPlatformServiceResolver } from "@takosjp/takosumi-platform-services";
import type { PostgresAccountsStore } from "@takosjp/takosumi-accounts-service";
import type { NodeAccountsServerConfig } from "./handler.ts";

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
   * Takosumi service exists so the account-plane Installer facade can proxy to
   * the in-process Installer API instead of falling back to direct ledger
   * mutations.
   */
  readonly createAccountsHandler?: (
    installer: InstallerProxyOptions,
  ) => AccountsHandler | Promise<AccountsHandler>;
  /**
   * Optional runtime env forwarded into the embedded Takosumi service. The composer
   * ensures an internal installer bearer is present so the in-process Accounts
   * facade can reach the Takosumi Installer API even when the operator did not
   * expose a public installer token.
   */
  readonly runtimeEnv?: CreateTakosumiServiceArg["runtimeEnv"];
  /**
   * Optional SQL client backing the Takosumi Installer API ledger so
   * Installation / Deployment records survive restarts. When omitted the
   * service falls back to its in-memory ledger (fine for dev / local-substrate).
   */
  readonly sqlClient?: CreateTakosumiServiceArg["sqlClient"];
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
}

type CreateTakosumiServiceArg = NonNullable<
  Parameters<typeof createTakosumiService>[0]
>;

/**
 * Build the one composed Hono app this distribution serves. Returns an outer
 * `app` that gives the account-plane `/v1/installations/*` projection precedence
 * over the embedded service Installer API (see the route-shadowing fix below) and
 * delegates everything else to the embedded service app, plus the `operations`
 * operate facade so the caller can drive install / deploy / rollback / status in
 * process if it wants to.
 */
export async function buildComposedApp(
  input: ComposedAppInput,
): Promise<CreatedTakosumiService> {
  const { runtimeEnv, installerToken } = embeddedServiceRuntimeEnv(
    input.runtimeEnv,
  );
  const cloudResolver = createTakosumiWorkloadPlatformServiceResolver({
    store: input.store,
    issuer: input.config.issuer,
    ...(input.config.workloadPlatformServices?.billingPortalUrl
      ? {
        billingPortalUrl:
          input.config.workloadPlatformServices.billingPortalUrl,
      }
      : {}),
    ...(input.config.workloadPlatformServices?.internalUrl
      ? { internalUrl: input.config.workloadPlatformServices.internalUrl }
      : {}),
  });
  // Adapt the cloud workload resolver to the service `PlatformServiceResolver`
  // interface. Exact listens pass `sourceRef`; discovery listens pass only
  // kind/labels/many and are delegated too so the operator resolver, rather
  // than the composer shim, owns the not-found / empty-collection semantics.
  type PlatformResolver = NonNullable<CreateTakosumiServiceArg["platformServices"]>;
  const platformServices: PlatformResolver = {
    resolve: (context) => {
      if (!context.installationId) return undefined;
      return (
        // Structurally-compatible return (readonly secretRef material); the
        // cast only satisfies the service resolver union, no runtime difference.
        cloudResolver.resolve({
          ...context,
          installationId: context.installationId,
        }) as ReturnType<PlatformResolver["resolve"]>
      );
    },
  };

  const created = await createTakosumiService({
    // Operators add native adapter implementation bindings (Docker Compose / systemd / etc.)
    // here; the reference Bun profile ships none by default but forwards
    // whatever the caller supplies.
    implementations: input.implementations ?? [],
    runtimeEnv,
    platformServices,
    // Default runtime git/tar runners are subprocess-backed, so this profile
    // accepts both git and prepared source without a custom runtime override.
    ...(input.sqlClient ? { sqlClient: input.sqlClient } : {}),
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

  const installer = inProcessInstallerProxy(serviceApp, installerToken);
  accountsHandler ??= input.createAccountsHandler
    ? await input.createAccountsHandler(installer)
    : undefined;
  if (!accountsHandler) {
    throw new TypeError(
      "buildComposedApp requires accountsHandler or createAccountsHandler",
    );
  }
  const mountedAccountsHandler = accountsHandler;

  // Route-shadowing fix. `createTakosumiService` registers the service Installer API
  // (`POST /v1/installations`, `/dry-run`, `/:id/deployments[/dry-run]`,
  // `/:id/rollback`) on the service app FIRST. Hono composes matched handlers in
  // registration order, so a later-registered handler on the same app can never
  // preempt those service routes. That permanently shadowed this operator
  // distribution's account-facing Installation projection — the account plane
  // mints `inst_<uuid>` ids and serves the ownership ledger at the SAME
  // `/v1/installations/*` paths, but every account-plane mutation hit the service
  // routes instead (and the service's `^ins_[0-9a-zA-Z]{16,32}$` id guard rejects
  // `inst_<uuid>` with 400, or 404s entirely when no installer token is set), so
  // the projection was unreachable.
  //
  // The account-plane routes remain externally canonical for
  // `/v1/installations/*`, but the handler is now wired with an in-process
  // Installer proxy, so create/deploy/rollback operations delegate into the
  // embedded service instead of bypassing the Installer API apply flow.
  const app = new Hono();
  if (input.preHandle) {
    app.use("*", async (c, next) => {
      const short = await input.preHandle?.(c.req.raw);
      if (short) return short;
      await next();
    });
  }
  app.all("/v1/installations", (c) => mountedAccountsHandler(c.req.raw));
  app.all("/v1/installations/*", (c) => mountedAccountsHandler(c.req.raw));
  app.all("*", (c) => serviceApp.fetch(c.req.raw));

  // The dev seam may resolve Hono's type from the sibling framework checkout
  // while this composer imports Hono from its own node_modules. Runtime Hono
  // objects are compatible; keep the cast at the framework/composer boundary.
  return { ...created, app: app as unknown as CreatedTakosumiService["app"] };
}

function inProcessInstallerProxy(
  serviceApp: CreatedTakosumiService["app"],
  token: string,
): InstallerProxyOptions {
  const url = "http://takosumi-service.internal";
  const fetchThroughService = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const request = new Request(input, init);
    const sourceUrl = new URL(request.url);
    const rewrittenUrl = new URL(
      `${sourceUrl.pathname}${sourceUrl.search}`,
      url,
    );
    const rewritten = new Request(rewrittenUrl, {
      method: request.method,
      headers: request.headers,
      body: request.method === "GET" || request.method === "HEAD"
        ? undefined
        : request.body,
      redirect: request.redirect,
      signal: request.signal,
    });
    return await serviceApp.fetch(rewritten);
  };
  return {
    url,
    token,
    fetch: fetchThroughService as typeof fetch,
  };
}

function embeddedServiceRuntimeEnv(
  configured: CreateTakosumiServiceArg["runtimeEnv"] | undefined,
): {
  readonly runtimeEnv: Record<string, string | undefined>;
  readonly installerToken: string;
} {
  const runtimeEnv: Record<string, string | undefined> = {
    ...((globalThis as {
      process?: { env?: Record<string, string | undefined> };
    }).process?.env ?? {}),
    ...(configured ?? {}),
  };
  const installerToken = nonEmpty(runtimeEnv.TAKOSUMI_INSTALLER_TOKEN) ??
    `embedded-${crypto.randomUUID()}`;
  return {
    runtimeEnv: {
      ...runtimeEnv,
      TAKOSUMI_INSTALLER_TOKEN: installerToken,
    },
    installerToken,
  };
}

function nonEmpty(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}
