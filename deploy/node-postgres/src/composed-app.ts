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
import type { AccountsHandler } from "@takosjp/takosumi-accounts-service";
import {
  issueInterfaceOAuthAccessToken,
  requireAccountsBearer,
} from "@takosjp/takosumi-accounts-service";
import {
  createTakosumiService,
  type CreatedTakosumiService,
} from "../../../core/bootstrap.ts";
import { selectSecretBoundaryCrypto } from "../../../core/adapters/secret-store/memory.ts";
import { ObjectKeyArtifactReferenceAllocator } from "../../../core/adapters/storage/artifact-references.ts";
import {
  TAKOSUMI_PRODUCT_CAPABILITIES_PATH,
  TAKOSUMI_WELL_KNOWN_PATH,
} from "takosumi-contract/api-surface";
import {
  createTakosumiProductCapabilities,
  createTakosumiWellKnownDocument,
  type CreateTakosumiDiscoveryOptions,
} from "takosumi-contract/capabilities";
import { Hono } from "hono";
import type { PostgresAccountsStore } from "@takosjp/takosumi-accounts-service";
import type { NodeAccountsServerConfig } from "./handler.ts";
import { createStaticAssetResponder } from "./static-assets.ts";
import {
  connectionOAuthDescriptorsFromEnv,
  REFERENCE_CREDENTIAL_RECIPE_COMPOSITION,
} from "@takosumi/providers";
import { createConnectionOAuthHelpers } from "../../../core/api/connection_oauth_helpers.ts";
import { REFERENCE_APP_INSTALL_CONFIGS } from "../../reference-app-install-configs.ts";

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
   * Takosumi service exists so the dashboard `/api/v1/*` control surface uses
   * the canonical typed operations facade.
   */
  readonly createAccountsHandler?: (
    controlPlaneOperations: CreatedTakosumiService["operations"],
  ) => AccountsHandler | Promise<AccountsHandler>;
  /**
   * Optional runtime env forwarded into the embedded Takosumi service. The
   * composer ensures an internal deploy-control bearer exists for the service's
   * own protected runner/callback routes.
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
   * so the browser/CLI smoke can exercise real source sync -> plan -> apply.
   */
  readonly opentofuRunner?: CreateTakosumiServiceArg["opentofuRunner"];
  readonly opentofuRunnerExecutors?: CreateTakosumiServiceArg["opentofuRunnerExecutors"];
  readonly runnerProfiles?: CreateTakosumiServiceArg["runnerProfiles"];
  readonly defaultRunnerProfileId?: CreateTakosumiServiceArg["defaultRunnerProfileId"];
  readonly managedVanityHostnameSlotsPerOwner?: CreateTakosumiServiceArg["managedVanityHostnameSlotsPerOwner"];
  /** Complete host-installed recipe catalog; defaults at this composition root. */
  readonly credentialRecipes?: CreateTakosumiServiceArg["credentialRecipes"];
  /** Complete host-installed app config set; an empty array disables references. */
  readonly operatorInstallConfigs?: CreateTakosumiServiceArg["operatorInstallConfigs"];
  /** Complete host-installed recipe driver registry. */
  readonly credentialRecipeDrivers?: CreateTakosumiServiceArg["credentialRecipeDrivers"];
  /** Host-installed guided connection setup dispatcher. */
  readonly buildConnectionSetupRequest?: CreateTakosumiServiceArg["buildConnectionSetupRequest"];
  /** Complete host-installed OAuth helper registry. */
  readonly connectionOAuthHelpers?: CreateTakosumiServiceArg["connectionOAuthHelpers"];
  /** Host ownership proof for custom Interface OAuth resource origins. */
  readonly interfaceOAuth2ResourceAuthorizer?: CreateTakosumiServiceArg["interfaceOAuth2ResourceAuthorizer"];
  /**
   * Extra request handling that must run before the embedded Takosumi app and
   * the accounts fallback (e.g. `/healthz`). Returns
   * a `Response` to short-circuit, or `undefined` to fall through.
   */
  readonly preHandle?: (req: Request) => Promise<Response | undefined>;
  /**
   * Optional product discovery capability overrides for the composed endpoint.
   * The origin is always derived from the incoming request so local, staging,
   * and hosted deployments produce self-referential discovery documents.
   */
  readonly productDiscovery?: Partial<CreateTakosumiDiscoveryOptions>;
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
 * `app` that delegates the canonical control-plane surface to the embedded
 * service app, mounts Accounts as the identity/dashboard facade, and exposes
 * the in-process `operations` facade.
 */
export async function buildComposedApp(
  input: ComposedAppInput,
): Promise<CreatedTakosumiService> {
  const { runtimeEnv } = embeddedServiceRuntimeEnv(input.runtimeEnv);
  const secretCrypto = selectSecretBoundaryCrypto({ env: runtimeEnv });
  const connectionOAuthHelpers =
    input.connectionOAuthHelpers ??
    createConnectionOAuthHelpers({
      stateSecret: runtimeEnv.TAKOSUMI_CONNECTION_OAUTH_STATE_SECRET,
      descriptors: connectionOAuthDescriptorsFromEnv(runtimeEnv),
    });
  let controlPlaneOperations: CreatedTakosumiService["operations"] | undefined;
  const created = await createTakosumiService({
    runtimeEnv,
    mountInternalLedgerRoutes: true,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    // The Bun/Postgres reference server explicitly installs the reference
    // provider contribution. Core has no fallback catalog or driver registry.
    credentialRecipes:
      input.credentialRecipes ??
      REFERENCE_CREDENTIAL_RECIPE_COMPOSITION.credentialRecipes,
    operatorInstallConfigs:
      input.operatorInstallConfigs ?? REFERENCE_APP_INSTALL_CONFIGS,
    credentialRecipeDrivers:
      input.credentialRecipeDrivers ??
      REFERENCE_CREDENTIAL_RECIPE_COMPOSITION.credentialRecipeDrivers,
    buildConnectionSetupRequest:
      input.buildConnectionSetupRequest ??
      REFERENCE_CREDENTIAL_RECIPE_COMPOSITION.buildConnectionSetupRequest,
    ...(connectionOAuthHelpers ? { connectionOAuthHelpers } : {}),
    ...(input.sqlClient ? { sqlClient: input.sqlClient } : {}),
    ...(input.opentofuRunner ? { opentofuRunner: input.opentofuRunner } : {}),
    ...(input.opentofuRunnerExecutors
      ? { opentofuRunnerExecutors: input.opentofuRunnerExecutors }
      : {}),
    ...(input.runnerProfiles ? { runnerProfiles: input.runnerProfiles } : {}),
    ...(input.defaultRunnerProfileId
      ? { defaultRunnerProfileId: input.defaultRunnerProfileId }
      : {}),
    ...(input.managedVanityHostnameSlotsPerOwner !== undefined
      ? {
          managedVanityHostnameSlotsPerOwner:
            input.managedVanityHostnameSlotsPerOwner,
        }
      : {}),
    ...(input.interfaceOAuth2ResourceAuthorizer
      ? {
          interfaceOAuth2ResourceAuthorizer:
            input.interfaceOAuth2ResourceAuthorizer,
        }
      : {}),
    secretCrypto,
    interfaceCredentialIssuer: {
      issuePrincipalOAuth2Token: async (tokenInput) => {
        const issued = await issueInterfaceOAuthAccessToken({
          store: input.store,
          subject: tokenInput.subjectId,
          workspaceId: tokenInput.workspaceId,
          ...(tokenInput.interfaceOwnerRef.kind === "Capsule"
            ? { capsuleId: tokenInput.interfaceOwnerRef.id }
            : {}),
          audience: tokenInput.resource,
          permission: tokenInput.permission,
          interfaceId: tokenInput.interfaceId,
          bindingId: tokenInput.bindingId,
          interfaceRevision: tokenInput.interfaceResolvedRevision,
          now: Date.parse(tokenInput.issuedAt),
        });
        return {
          accessToken: issued.accessToken,
          expiresAt: new Date(issued.expiresAt).toISOString(),
        };
      },
    },
    authorizeInterfaceBearer: async ({ request }) => {
      const isInterfaceTokenIssue =
        request.method === "POST" &&
        /^\/v1\/interfaces\/[^/]+\/token$/u.test(new URL(request.url).pathname);
      const requiredScope =
        request.method === "GET" ||
        request.method === "HEAD" ||
        isInterfaceTokenIssue
          ? "read"
          : "write";
      const result = await requireAccountsBearer({
        request,
        store: input.store,
        scope: requiredScope,
      });
      if (!result.ok) return undefined;
      const runtimePrincipal = result.auth.credential === "oauth-access-token";
      // Runtime OAuth subjects are pairwise client subjects, not account
      // owners. They must therefore carry the Workspace bound into the access
      // token; session/PAT actors are checked against current account ownership
      // once the Interface route resolves its authoritative Workspace.
      if (runtimePrincipal && !result.auth.workspaceId) return undefined;
      return {
        actorAccountId: result.auth.principalSubject ?? result.auth.subject,
        ...(result.auth.workspaceId
          ? { workspaceId: result.auth.workspaceId }
          : {}),
        roles: runtimePrincipal
          ? ["runtime-principal"]
          : [requiredScope === "read" ? "viewer" : "editor"],
        requestId: request.headers.get("x-request-id") ?? crypto.randomUUID(),
        principalKind: "account",
        scopes: [requiredScope],
      };
    },
    authorizeInterfaceWorkspace: async ({ actor, workspaceId }) => {
      // OAuth runtime delivery is already bound to the Workspace recorded on
      // the access token. Its actorAccountId is pairwise and cannot be compared
      // to the account-plane legal owner.
      if (actor.roles.includes("runtime-principal")) {
        return actor.workspaceId === workspaceId;
      }
      const operations = controlPlaneOperations;
      if (!operations) return false;
      try {
        const workspace = await operations.workspaces.getWorkspace(workspaceId);
        if (workspace.ownerUserId === actor.actorAccountId) return true;
        const members = await operations.members.listMembers(workspaceId);
        return members.some(
          (member) =>
            member.accountId === actor.actorAccountId &&
            member.status === "active",
        );
      } catch {
        return false;
      }
    },
  });
  controlPlaneOperations = created.operations;

  const serviceApp = created.app;
  // Account-plane fallback INSIDE the embedded Takosumi service app. The Takosumi Accounts
  // handler is one fetch handler that internally routes the dashboard, billing,
  // OIDC, and install UI paths; `app.route('/dashboard', …)` would split that
  // single handler, so we mount it as the catch-all the service app does not
  // claim. This reaches account-plane surfaces (dashboard /
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

  accountsHandler ??= input.createAccountsHandler
    ? await input.createAccountsHandler(created.operations)
    : undefined;
  if (!accountsHandler) {
    throw new TypeError(
      "buildComposedApp requires accountsHandler or createAccountsHandler",
    );
  }
  const app = new Hono();
  if (input.preHandle) {
    app.use("*", async (c, next) => {
      const short = await input.preHandle?.(c.req.raw);
      if (short) return short;
      await next();
    });
  }
  // Product discovery is used by the takosumi OpenTofu provider, CLIs, and
  // mobile clients. Keep it on the outer composed app so the account-plane OIDC
  // `/.well-known/*` fallback and `/v1/*` identity surface cannot shadow it.
  app.get(TAKOSUMI_WELL_KNOWN_PATH, (c) =>
    c.json(
      createTakosumiWellKnownDocument(
        productDiscoveryOptions(c.req.raw, input.productDiscovery),
      ),
    ),
  );
  app.get(TAKOSUMI_PRODUCT_CAPABILITIES_PATH, (c) =>
    c.json(
      createTakosumiProductCapabilities(
        productDiscoveryOptions(c.req.raw, input.productDiscovery),
      ),
    ),
  );
  // Serve the dashboard SPA for non-API navigations (after preHandle's
  // /healthz, before the API routes). API namespaces are
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
  app.all("*", (c) => serviceApp.fetch(c.req.raw));

  // The dev seam may resolve Hono's type from the sibling framework checkout
  // while this composer imports Hono from its own node_modules. Runtime Hono
  // objects are compatible; keep the cast at the framework/composer boundary.
  return { ...created, app: app as unknown as CreatedTakosumiService["app"] };
}

function productDiscoveryOptions(
  req: Request,
  overrides: Partial<CreateTakosumiDiscoveryOptions> | undefined,
): CreateTakosumiDiscoveryOptions {
  return {
    ...(overrides ?? {}),
    interfacesEnabled: overrides?.interfacesEnabled ?? true,
    origin: publicOriginFromRequest(req),
  };
}

function publicOriginFromRequest(req: Request): string {
  const url = new URL(req.url);
  const forwardedProto = firstForwardedHeader(
    req.headers.get("x-forwarded-proto"),
  );
  const forwardedHost = firstForwardedHeader(
    req.headers.get("x-forwarded-host"),
  );
  const proto = forwardedProto ?? url.protocol.replace(/:$/, "");
  const host = forwardedHost ?? req.headers.get("host") ?? url.host;
  return `${proto}://${host}`;
}

function firstForwardedHeader(value: string | null): string | undefined {
  const first = value?.split(",")[0]?.trim();
  return first && first.length > 0 ? first : undefined;
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
