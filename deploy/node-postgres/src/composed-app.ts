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
import {
  InMemoryCapsuleCoordination,
  type CapsuleCoordination,
} from "../../../core/domains/deploy-control/capsule_lease.ts";
import { OpenTofuControllerError } from "../../../core/domains/deploy-control/errors.ts";
import type { RuntimeInputOidcClientSource } from "../../../core/domains/deploy-control/runtime_input_materializer.ts";
import type { RuntimeInputOidcControlLedger } from "../../../deploy/platform/runtime_input_oidc_client_source.ts";
import type { CapsuleOidcAccountsLedger } from "../../../deploy/platform/accounts_oidc_client_registration.ts";

export interface RuntimeInputOidcClientSourceFactoryInput {
  readonly control: RuntimeInputOidcControlLedger;
  readonly accounts: CapsuleOidcAccountsLedger;
  readonly issuer: string;
}

export type RuntimeInputOidcClientSourceFactory = (
  input: RuntimeInputOidcClientSourceFactoryInput,
) => RuntimeInputOidcClientSource | Promise<RuntimeInputOidcClientSource>;

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
   * Optional Accounts authority for manifest-gated runtime `identity.oidc`
   * bindings. Core owns the runtime-input protocol but not Accounts client
   * registration, so the host supplies the existing registration authority
   * after the embedded service operations facade has been created.
   */
  readonly createRuntimeInputOidcClientSource?: RuntimeInputOidcClientSourceFactory;
  /** Private host key forwarded to Core's runtime-binding derivation lane. */
  readonly runtimeBindingDerivationKey?:
    CreateTakosumiServiceArg["runtimeBindingDerivationKey"];
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
  /** Host-pinned immutable identities for terminal mutation evidence. */
  readonly executionEvidenceAuthority?: CreateTakosumiServiceArg["executionEvidenceAuthority"];
  readonly defaultRunnerProfileId?: CreateTakosumiServiceArg["defaultRunnerProfileId"];
  /**
   * Shared Capsule lifecycle coordinator. The single-process Bun composition
   * defaults to one in-memory instance; multi-replica operators must inject a
   * durable shared implementation rather than relying on process-local locks.
   */
  readonly capsuleCoordination?: CapsuleCoordination;
  /** Complete host-installed recipe catalog; defaults at this composition root. */
  readonly credentialRecipes?: CreateTakosumiServiceArg["credentialRecipes"];
  /** Fixed, credentialless operator Connections projected by the host release. */
  readonly operatorProviderConnections?:
    CreateTakosumiServiceArg["operatorProviderConnections"];
  /** Host-owned signer for canonical Run-scoped recipe credentials. */
  readonly runCredentialIssuer?: CreateTakosumiServiceArg["runCredentialIssuer"];
  /** Explicit opt-in for workspace bindings to projected operator Connections. */
  readonly allowOperatorScopedProviderConnections?:
    CreateTakosumiServiceArg["allowOperatorScopedProviderConnections"];
  /** Complete host-installed config set; omitted means no app-specific entries. */
  readonly operatorInstallConfigs?: CreateTakosumiServiceArg["operatorInstallConfigs"];
  /** Complete host-installed recipe driver registry. */
  readonly credentialRecipeDrivers?: CreateTakosumiServiceArg["credentialRecipeDrivers"];
  /** Complete host-installed Source credential driver registry. */
  readonly sourceCredentialDrivers?: CreateTakosumiServiceArg["sourceCredentialDrivers"];
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
  const capsuleCoordination =
    input.capsuleCoordination ?? new InMemoryCapsuleCoordination();
  const deferredRuntimeInputOidcClientSource =
    input.createRuntimeInputOidcClientSource
      ? createDeferredRuntimeInputOidcClientSource()
      : undefined;
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
    ...(input.operatorProviderConnections !== undefined
      ? { operatorProviderConnections: input.operatorProviderConnections }
      : {}),
    operatorInstallConfigs: input.operatorInstallConfigs ?? [],
    credentialRecipeDrivers:
      input.credentialRecipeDrivers ??
      REFERENCE_CREDENTIAL_RECIPE_COMPOSITION.credentialRecipeDrivers,
    ...(input.runCredentialIssuer !== undefined
      ? { runCredentialIssuer: input.runCredentialIssuer }
      : {}),
    ...(input.allowOperatorScopedProviderConnections !== undefined
      ? {
          allowOperatorScopedProviderConnections:
            input.allowOperatorScopedProviderConnections,
        }
      : {}),
    sourceCredentialDrivers:
      input.sourceCredentialDrivers ??
      REFERENCE_CREDENTIAL_RECIPE_COMPOSITION.sourceCredentialDrivers,
    buildConnectionSetupRequest:
      input.buildConnectionSetupRequest ??
      REFERENCE_CREDENTIAL_RECIPE_COMPOSITION.buildConnectionSetupRequest,
    ...(connectionOAuthHelpers ? { connectionOAuthHelpers } : {}),
    ...(input.sqlClient ? { sqlClient: input.sqlClient } : {}),
    ...(deferredRuntimeInputOidcClientSource
      ? {
          runtimeInputOidcClientSource:
            deferredRuntimeInputOidcClientSource.client,
        }
      : {}),
    ...(input.runtimeBindingDerivationKey !== undefined
      ? { runtimeBindingDerivationKey: input.runtimeBindingDerivationKey }
      : {}),
    ...(input.opentofuRunner ? { opentofuRunner: input.opentofuRunner } : {}),
    ...(input.opentofuRunnerExecutors
      ? { opentofuRunnerExecutors: input.opentofuRunnerExecutors }
      : {}),
    ...(input.runnerProfiles ? { runnerProfiles: input.runnerProfiles } : {}),
    ...(input.executionEvidenceAuthority
      ? { executionEvidenceAuthority: input.executionEvidenceAuthority }
      : {}),
    capsuleCoordination,
    ...(input.defaultRunnerProfileId
      ? { defaultRunnerProfileId: input.defaultRunnerProfileId }
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
    authorizeInterfaceBearer: async ({ token, request }) => {
      const requiredScope = interfaceRequestAccess(request);
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
        // The account's real Workspace role is unknown here: the authoritative
        // Workspace is resolved later by the Interface route. A role claimed
        // from the HTTP method would be a fabricated grant, so account
        // principals carry no role claim and authority is decided against the
        // live membership row in `authorizeInterfaceWorkspace`.
        roles: runtimePrincipal ? ["runtime-principal"] : [],
        requestId: request.headers.get("x-request-id") ?? crypto.randomUUID(),
        principalKind: "account",
        scopes: [requiredScope],
      };
    },
    authorizeInterfaceWorkspace: async ({ actor, workspaceId, request }) => {
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
        const member = await operations.members.getMember(
          workspaceId,
          actor.actorAccountId,
        );
        if (member?.status !== "active") return false;
        if (interfaceRequestAccess(request) === "read") return true;
        // Active membership alone is read authority. Interface and
        // InterfaceBinding writes mint runtime credentials against the
        // Workspace's Resources and revoke existing grants, so a read-only
        // (`viewer`) membership must not reach them. An empty role set proves
        // no write role, so it is refused too.
        return member.roles.some((role) => role !== "viewer");
      } catch {
        return false;
      }
    },
  });
  controlPlaneOperations = created.operations;
  if (input.createRuntimeInputOidcClientSource) {
    const source = await input.createRuntimeInputOidcClientSource(
      Object.freeze({
        control: createRuntimeInputOidcControlLedger(created.operations),
        accounts: createRuntimeInputOidcAccountsLedger(input.store),
        issuer: input.config.issuer,
      }),
    );
    deferredRuntimeInputOidcClientSource!.initialize(source);
  }

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

/**
 * The runtime-input host seam receives only the three Core reads needed to
 * validate Capsule authority. Missing rows map to `undefined`; other control
 * errors remain visible to the source instead of being mistaken for absence.
 */
function createRuntimeInputOidcControlLedger(
  operations: CreatedTakosumiService["operations"],
): RuntimeInputOidcControlLedger {
  return Object.freeze({
    getCapsule: async (id: string) =>
      await readOptional(() => operations.capsules.getCapsule(id)),
    getInstallConfig: async (id: string) =>
      await readOptional(() => operations.capsules.getInstallConfig(id)),
    getCapsuleExecutionAuthorityEpoch: async (id: string) =>
      await readOptional(() =>
        operations.capsules.getCapsuleExecutionAuthorityEpoch(id),
      ),
  });
}

/**
 * Accounts registration methods are the only mutable authority the source
 * needs. Bind them to the existing store instance without exposing its wider
 * query, migration, or account-management surface.
 */
function createRuntimeInputOidcAccountsLedger(
  store: PostgresAccountsStore,
): CapsuleOidcAccountsLedger {
  return Object.freeze({
    findOidcClient: store.findOidcClient.bind(store),
    findOidcClientForCapsule: store.findOidcClientForCapsule.bind(store),
    saveOidcClient: store.saveOidcClient.bind(store),
  });
}

async function readOptional<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof OpenTofuControllerError && error.code === "not_found") {
      return undefined;
    }
    throw error;
  }
}

interface DeferredRuntimeInputOidcClientSource {
  readonly client: RuntimeInputOidcClientSource;
  initialize(source: RuntimeInputOidcClientSource): void;
}

/**
 * Core constructs its runtime materializer before the host has a chance to
 * finish composing Accounts. Keep the Core port present from construction, but
 * defer every call until the host has supplied the one existing Accounts
 * authority. A call before initialization is a boot error, never a partial
 * runtime-input delivery.
 */
function createDeferredRuntimeInputOidcClientSource(): DeferredRuntimeInputOidcClientSource {
  let source: RuntimeInputOidcClientSource | undefined;
  const requireSource = (): RuntimeInputOidcClientSource => {
    if (!source) {
      throw new TypeError(
        "runtime input OIDC client source is not initialized",
      );
    }
    return source;
  };
  return {
    client: {
      generation: async (input) => await requireSource().generation(input),
      materialize: async (input) => await requireSource().materialize(input),
      retire: async (input) => {
        const current = requireSource();
        if (current.retire) await current.retire(input);
      },
    },
    initialize(next) {
      if (
        next === null ||
        typeof next !== "object" ||
        typeof next.generation !== "function" ||
        typeof next.materialize !== "function"
      ) {
        throw new TypeError(
          "createRuntimeInputOidcClientSource must return generation and materialize methods",
        );
      }
      if (source) {
        throw new TypeError(
          "runtime input OIDC client source is already initialized",
        );
      }
      source = next;
    },
  };
}

/**
 * The one Interface API access-mode rule for this host: reads and the
 * binding-bound token issue route need read authority, every other request
 * mutates Interface or InterfaceBinding state. Both the bearer check and the
 * Workspace membership check derive the mode here so the credential scope and
 * the required Workspace role can never disagree.
 */
function interfaceRequestAccess(request: Request): "read" | "write" {
  const isInterfaceTokenIssue =
    request.method === "POST" &&
    /^\/api\/v1\/interfaces\/[^/]+\/token$/u.test(new URL(request.url).pathname);
  return request.method === "GET" ||
    request.method === "HEAD" ||
    isInterfaceTokenIssue
    ? "read"
    : "write";
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
