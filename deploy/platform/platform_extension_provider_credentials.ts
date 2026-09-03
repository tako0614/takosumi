import type {
  CredentialRecipeDriverContext,
  CredentialRecipeHostComposition,
} from "takosumi-contract/credential-recipe-host";
import type {
  Capsule,
  CapsulePublicOriginReservation,
} from "../../contract/capsules.ts";
import type { InstallConfig } from "../../contract/install-configs.ts";
import { installExperienceServiceNameVariable } from "../../contract/install-experience.ts";
import {
  capsuleSlug,
  workspaceSlugSuffix,
} from "../../core/domains/capsules/repository_install_ux_compiler.ts";
import type { RuntimeInputCapsulePublicOrigin } from "./runtime_input_oidc_client_source.ts";
import {
  platformExtensionRoutes,
  type PlatformExtensionProviderCredentialBroker,
  type PlatformExtensionRoute,
} from "./platform_extensions.ts";

const AUTH_MODE = "broker";
const MAX_RESPONSE_BYTES = 64 * 1024;
const EVIDENCE_ISSUER = "platform_extension_provider_credential";
const PUBLIC_INPUT_AUTH_KIND = "provider-public-input";
const PUBLIC_INPUT_CAPABILITY = "http_endpoint_url";
const PUBLIC_INPUT_REQUEST_KIND =
  "takosumi.provider-public-input-reservation-request@v1";
const PUBLIC_INPUT_RELEASE_KIND =
  "takosumi.provider-public-input-reservation-release@v1";
const PUBLIC_INPUT_RESERVATION_KIND =
  "takosumi.provider-public-input-reservation@v1";
const PUBLIC_INPUT_RELEASED_KIND = "takosumi.provider-public-input-release@v1";
const PUBLIC_INPUT_IDEMPOTENCY_DOMAIN =
  "takosumi.capsule-public-origin-request/v1";
// Keep the platform-extension RPC below the generic root-dispatch 25-second
// outer deadline so a stalled dynamic RPC proxy fails closed before the caller.
const PUBLIC_INPUT_RPC_DEADLINE_MS = 5_000;
const PUBLIC_INPUT_RPC_TIMEOUT = Symbol(
  "platform-extension-public-input-timeout",
);
/**
 * The reservation label the host is asked for. It is a DNS label, not a
 * hostname: Takosumi contributes the name it reviewed and the host alone owns
 * the suffix, the scheme, and whether the label is even acceptable.
 */
const REQUESTED_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
/**
 * Settings key carrying the plan-pinned reservation into the Apply-phase
 * credential exchange. It is provider-neutral and opaque: the extension, not
 * Takosumi, knows what its host does with the reference.
 */
const RESERVATION_SETTINGS_KEY = "publicInputReservationRef";

/**
 * Compiles provider-neutral extension descriptors into one code-only
 * Credential Recipe contribution. The extension still owns provider behavior
 * and credentials; OSS only owns Run authority and exact env delivery.
 */
export function platformExtensionProviderCredentialComposition(
  env: {
    readonly TAKOSUMI_PLATFORM_EXTENSIONS?: unknown;
    readonly TAKOSUMI_ACCOUNTS_ISSUER?: unknown;
  },
  options: {
    /**
     * Read side of the same reservation ledger
     * {@link capsulePublicOriginFromPlatformExtensions} writes at plan. Apply
     * must hand the extension the reservation the reviewed plan pinned, or the
     * host has no way to bind the endpoint it publishes to the origin the
     * Capsule's OIDC redirect was registered for.
     */
    readonly capsulePublicOriginReservations?: PlatformExtensionCapsulePublicOriginLedger;
  } = {},
): CredentialRecipeHostComposition | undefined {
  const routes = platformExtensionRoutes(env).filter(
    (route) => route.providerCredentialBroker !== undefined,
  );
  if (routes.length === 0) return undefined;
  const credentialRequiredProviderSources = sortedProviderSources(routes);
  const origin = exactHttpsOrigin(env.TAKOSUMI_ACCOUNTS_ISSUER);
  const credentialRecipes: CredentialRecipeHostComposition["credentialRecipes"] =
    routes.map((route) => {
      const broker = route.providerCredentialBroker!;
      const issuance = route.runCredential!;
      return Object.freeze({
        id: broker.recipeId,
        displayName: broker.displayName,
        terraformSource: Object.freeze([broker.providerSource]),
        envNames: broker.envNames,
        requiredEnvGroups: Object.freeze(
          broker.envNames.map((name) => Object.freeze([name])),
        ),
        authModes: Object.freeze({
          [AUTH_MODE]: Object.freeze({
            preRun: Object.freeze({
              type: "platform_extension_provider_credential",
            }),
            runIssuance: Object.freeze({
              context: "capsule-run.v1" as const,
              operatorConnection: "workspace-bindable" as const,
              storedMaterial: "none" as const,
              audience: issuance.audience,
              scopes: issuance.requiredScopes,
            }),
            // A broker Connection that does not declare the protocol cannot
            // carry the Capsule's runtime binding profile at all: the run-scoped
            // wiring selects ONLY on this pinned, value-free descriptor.
            ...(broker.runtimeInputs
              ? { runtimeInputs: broker.runtimeInputs }
              : {}),
          }),
        }),
      });
    });
  const credentialRecipeDrivers: Record<
    string,
    CredentialRecipeHostComposition["credentialRecipeDrivers"][string]
  > = {};
  for (const route of routes) {
    const broker = route.providerCredentialBroker!;
    const issuance = route.runCredential!;
    const handler = platformExtensionCredentialHandler(env, route.handlerKey);
    credentialRecipeDrivers[`${broker.recipeId}/${AUTH_MODE}`] = {
      evidenceIssuer: EVIDENCE_ISSUER,
      verify: async () => ({ ok: true }),
      mint: async (context) =>
        await mintPlatformExtensionProviderCredential(
          context,
          origin,
          route.basePath,
          broker.exchangePath,
          broker.providerSource,
          broker.envNames,
          issuance.audience,
          issuance.requiredScopes,
          handler,
          broker.publicInputExchangePath === undefined
            ? undefined
            : options.capsulePublicOriginReservations,
        ),
    };
  }
  return Object.freeze({
    credentialRecipes: Object.freeze([...credentialRecipes]),
    credentialRecipeDrivers: Object.freeze(credentialRecipeDrivers),
    credentialRequiredProviderSources,
    operatorProviderConnections: Object.freeze(
      routes.map((route) => {
        const broker = route.providerCredentialBroker!;
        return Object.freeze({
          id: broker.connectionId,
          providerSource: broker.providerSource,
          displayName: broker.displayName,
          credentialRecipe: Object.freeze({
            id: broker.recipeId,
            authMode: AUTH_MODE,
          }),
          ...(broker.runCredentialSettings
            ? { runCredentialSettings: broker.runCredentialSettings }
            : {}),
        });
      }),
    ),
  });
}

function sortedProviderSources(
  routes: readonly PlatformExtensionRoute[],
): readonly string[] {
  return Object.freeze(
    Array.from(
      new Set(
        routes.flatMap((route) =>
          route.providerCredentialBroker
            ? [route.providerCredentialBroker.providerSource]
            : [],
        ),
      ),
    ).sort(),
  );
}

async function mintPlatformExtensionProviderCredential(
  context: CredentialRecipeDriverContext,
  origin: string,
  basePath: string,
  exchangePath: string,
  providerSource: string,
  envNames: readonly string[],
  audience: string,
  scopes: readonly string[],
  handler: PlatformExtensionCredentialHandler | undefined,
  publicOriginReservations?: PlatformExtensionCapsulePublicOriginLedger,
) {
  if (!context.run || !context.issueRunCredential) {
    logCredentialExchangeFailure("context_unavailable");
    throw new Error("provider credential exchange requires a canonical Run");
  }
  const declaredSettings = context.runCredentialSettings ?? Object.freeze({});
  // The plan-pinned reservation travels with the Apply-phase exchange so the
  // extension can bind its host's endpoint to the exact origin this Capsule's
  // reviewed plan already committed to. Its absence is not a failure: a Capsule
  // that never needed a public origin has no reservation to carry.
  let reservationRef: string | undefined;
  if (publicOriginReservations) {
    try {
      reservationRef = heldReservation(
        await publicOriginReservations.read(context.run.capsuleId),
      )?.reservationRef;
    } catch {
      logCredentialExchangeFailure("public_origin_reservation_unavailable");
      throw new Error("provider credential exchange reservation is unreadable");
    }
  }
  const runCredentialSettings =
    reservationRef === undefined
      ? declaredSettings
      : Object.freeze({
          ...declaredSettings,
          [RESERVATION_SETTINGS_KEY]: reservationRef,
        });
  if (!handler) {
    logCredentialExchangeFailure("handler_unavailable");
    throw new Error("provider credential exchange requires a bound handler");
  }
  // Keep the platform credential wider than the downstream 300-second
  // provider token so small cross-service clock/latency differences cannot
  // make a valid response appear to outlive its caller authority.
  let issued: Awaited<
    ReturnType<NonNullable<typeof context.issueRunCredential>>
  >;
  try {
    issued = await context.issueRunCredential({ ttlSeconds: 600 });
  } catch {
    logCredentialExchangeFailure("issuance_failed");
    throw new Error("provider credential exchange issuance failed");
  }
  const url = new URL(`${basePath}${exchangePath}`, origin);
  url.searchParams.set("workspaceId", context.run.workspaceId);
  const exchangeRequest = Object.freeze({
    kind: "takosumi.provider-run-credential-request@v1" as const,
    providerSource,
    settings: runCredentialSettings,
  });
  const exchangeContext = Object.freeze({
    authKind: "run-credential" as const,
    subject: context.run.installingPrincipalId,
    workspaceId: context.run.workspaceId,
    capsuleId: context.run.capsuleId,
    runId: context.run.runId,
    installingPrincipalId: context.run.installingPrincipalId,
    audience,
    scopes: Object.freeze([...scopes]),
    phase: context.run.phase,
    lifecycleIntent: context.run.lifecycleIntent,
  });
  let responseStatus: number;
  let responseBytes: Uint8Array;
  try {
    if (handler.exchangeProviderCredential) {
      const exchanged = await handler.exchangeProviderCredential(
        Object.freeze({
          url: url.href,
          request: exchangeRequest,
          context: exchangeContext,
        }),
      );
      if (
        !isRecord(exchanged) ||
        !exactKeys(exchanged, ["body", "status"]) ||
        !Number.isSafeInteger(exchanged.status) ||
        (exchanged.status as number) < 100 ||
        (exchanged.status as number) > 599 ||
        typeof exchanged.body !== "string"
      ) {
        throw new Error("provider credential RPC returned an invalid envelope");
      }
      responseStatus = exchanged.status as number;
      responseBytes = new TextEncoder().encode(exchanged.body);
    } else if (handler.fetchAuthenticated) {
      const response = await handler.fetchAuthenticated(
        new Request(url.href, {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
          },
          body: JSON.stringify(exchangeRequest),
        }),
        exchangeContext,
      );
      responseStatus = response.status;
      const declaredLength = Number(
        response.headers.get("content-length") ?? "NaN",
      );
      if (
        Number.isFinite(declaredLength) &&
        declaredLength > MAX_RESPONSE_BYTES
      ) {
        throw new Error("provider credential exchange response is too large");
      }
      responseBytes = new Uint8Array(await response.arrayBuffer());
    } else {
      throw new Error("provider credential exchange handler is unavailable");
    }
  } catch {
    logCredentialExchangeFailure("handler_rpc_failed");
    throw new Error("provider credential exchange handler failed");
  }
  if (responseStatus < 200 || responseStatus > 299) {
    // The vault intentionally collapses provider-driver failures into the
    // public `credential_service_unavailable` diagnostic. Preserve only the
    // non-secret HTTP boundary here so an operator can distinguish platform
    // authentication, extension validation, and upstream availability
    // failures without logging the bearer, response body, Workspace, or Run.
    logCredentialExchangeFailure("handler_response_failed", responseStatus);
    throw new Error("provider credential exchange failed");
  }
  if (responseBytes.byteLength > MAX_RESPONSE_BYTES) {
    throw new Error("provider credential exchange response is too large");
  }
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(responseBytes),
    ) as unknown;
  } catch {
    throw new Error("provider credential exchange response is malformed");
  }
  if (!isRecord(value) || !exactKeys(value, ["env", "expiresAt", "kind"])) {
    throw new Error("provider credential exchange response is malformed");
  }
  if (
    value.kind !== "takosumi.provider-run-credential@v1" ||
    !isRecord(value.env) ||
    !exactKeys(value.env, envNames) ||
    typeof value.expiresAt !== "string"
  ) {
    throw new Error("provider credential exchange response is malformed");
  }
  const env: Record<string, string> = {};
  for (const name of envNames) {
    const entry = value.env[name];
    if (
      typeof entry !== "string" ||
      entry.length === 0 ||
      entry.length > 8_192 ||
      /[\u0000-\u001f\u007f]/u.test(entry)
    ) {
      throw new Error("provider credential exchange response is malformed");
    }
    env[name] = entry;
  }
  const expiresAt = Date.parse(value.expiresAt);
  const issuerExpiresAt = Date.parse(issued.expiresAt);
  const nowMs = context.now().getTime();
  if (
    !Number.isFinite(expiresAt) ||
    new Date(expiresAt).toISOString() !== value.expiresAt ||
    expiresAt - nowMs < 1_000 ||
    !Number.isFinite(issuerExpiresAt) ||
    expiresAt > issuerExpiresAt
  ) {
    throw new Error("provider credential exchange expiry is invalid");
  }
  const ttlSeconds = Math.floor((expiresAt - nowMs) / 1_000);
  return {
    env: Object.freeze(env),
    evidence: Object.freeze({
      connectionId: context.connection.id,
      provider: context.connection.provider,
      temporary: true,
      ttlEnforced: true,
      expiresAt: value.expiresAt,
      ttlSeconds,
      issuer: EVIDENCE_ISSUER,
      secretValueStored: false as const,
    }),
  };
}

function logCredentialExchangeFailure(stage: string, status?: number): void {
  console.warn(
    JSON.stringify({
      event: "platform_extension_provider_credential_exchange_failed",
      stage,
      ...(status === undefined ? {} : { status }),
    }),
  );
}

interface PlatformExtensionCredentialHandler {
  /**
   * Non-secret public-input exchange. It is deliberately a SECOND method: a
   * credential exchange mints run-scoped secret material for one Run, while
   * this one asks a durable, value-free question whose answer outlives the Run
   * and is safe to persist on the Capsule.
   */
  exchangeProviderPublicInput?(input: {
    readonly url: string;
    readonly request: Readonly<Record<string, unknown>>;
    readonly context: {
      readonly authKind: typeof PUBLIC_INPUT_AUTH_KIND;
      readonly providerSource: string;
      readonly workspaceId: string;
    };
  }): Promise<{ readonly status: number; readonly body: string }>;
  exchangeProviderCredential?(input: {
    readonly url: string;
    readonly request: Readonly<Record<string, unknown>>;
    readonly context: {
      readonly authKind: "run-credential";
      readonly subject: string;
      readonly workspaceId: string;
      readonly capsuleId: string;
      readonly runId: string;
      readonly installingPrincipalId: string;
      readonly audience: string;
      readonly scopes: readonly string[];
      readonly phase: "plan" | "apply" | "destroy";
      readonly lifecycleIntent: "provision" | "destroy";
    };
  }): Promise<{ readonly status: number; readonly body: string }>;
  fetchAuthenticated?(
    request: Request,
    context: {
      readonly authKind: "run-credential";
      readonly subject: string;
      readonly workspaceId: string;
      readonly capsuleId: string;
      readonly runId: string;
      readonly installingPrincipalId: string;
      readonly audience: string;
      readonly scopes: readonly string[];
      readonly phase: "plan" | "apply" | "destroy";
      readonly lifecycleIntent: "provision" | "destroy";
    },
  ): Promise<Response>;
}

// ---------------------------------------------------------------------------
// Capsule public origin
// ---------------------------------------------------------------------------

/**
 * Durable store for the one host reservation a Capsule holds.
 *
 * Plan asks the host to fix an origin; Apply must read that SAME reservation
 * back rather than ask for another. The reference therefore has to outlive the
 * Run, which is why this is a ledger and not Run state.
 */
export interface PlatformExtensionCapsulePublicOriginLedger {
  /** The Capsule's whole reservation record, released ones included. */
  read(capsuleId: string): Promise<CapsulePublicOriginReservation | undefined>;
  write(
    capsuleId: string,
    reservation: CapsulePublicOriginReservation,
  ): Promise<void>;
}

/**
 * A reservation the host is still holding.
 *
 * A released record is kept rather than erased — it is the evidence that a
 * teardown actually finished — so "held" is a question about the record's
 * contents, never about its presence.
 */
function heldReservation(
  reservation: CapsulePublicOriginReservation | undefined,
): CapsulePublicOriginReservation | undefined {
  return reservation && reservation.releasedAt === undefined
    ? reservation
    : undefined;
}

/** Host authority for a Capsule's public origin, plus its teardown half. */
export interface PlatformExtensionCapsulePublicOriginPort {
  readonly resolve: RuntimeInputCapsulePublicOrigin;
  /**
   * Best-effort release once the Capsule is destroyed and its endpoint is gone.
   * A reservation nobody releases pins an origin forever, so this never throws:
   * a failed release leaves a host-side orphan a later teardown can still
   * remove, and must not fail a terminal destroy.
   */
  release(input: {
    readonly workspaceId: string;
    readonly capsuleId: string;
  }): Promise<void>;
}

export interface PlatformExtensionCapsulePublicOriginOptions {
  /** Test seam for the bounded host RPC; production defaults to five seconds. */
  readonly handlerRpcDeadlineMs?: number;
}

/**
 * The Capsule public-origin port, composed from the platform extension seam.
 *
 * Takosumi OSS neither allocates nor derives a Capsule's public origin: it asks
 * the host composition that publishes the Worker, over the SAME provider-neutral
 * extension route that already brokers that provider's run credentials. Nothing
 * here knows a host product, a hostname scheme, a suffix, a tenant, a space, or
 * a provider-native resource name — only a reviewed label to request and an
 * opaque reference to re-present.
 *
 * Returns `undefined` when no configured route can answer the question. Capsules
 * that need an answer then fail closed at plan, which is the correct outcome:
 * registering a redirect URI for an origin nobody serves is worse than not
 * planning at all.
 */
export function capsulePublicOriginFromPlatformExtensions(
  env: {
    readonly TAKOSUMI_PLATFORM_EXTENSIONS?: unknown;
    readonly TAKOSUMI_ACCOUNTS_ISSUER?: unknown;
  },
  ledger: PlatformExtensionCapsulePublicOriginLedger,
  clock: () => Date = () => new Date(),
  options: PlatformExtensionCapsulePublicOriginOptions = {},
): PlatformExtensionCapsulePublicOriginPort | undefined {
  const routes = platformExtensionRoutes(env).filter((route) =>
    brokerAnswersPublicOrigin(route.providerCredentialBroker),
  );
  if (routes.length === 0) return undefined;
  if (routes.length > 1) {
    // One Capsule has one public origin. Two routes claiming to answer for it
    // is a composition mistake with no safe resolution, and picking either one
    // silently would decide an authority question by array order.
    throw new TypeError(
      "more than one platform extension route answers the Capsule public-origin question; a Capsule has one public origin and no rule for splitting it",
    );
  }
  const route = routes[0]!;
  const broker = route.providerCredentialBroker!;
  const origin = exactHttpsOrigin(env.TAKOSUMI_ACCOUNTS_ISSUER);
  const url = new URL(
    `${route.basePath}${broker.publicInputExchangePath!}`,
    origin,
  ).href;
  const handlerRpcDeadlineMs =
    Number.isFinite(options.handlerRpcDeadlineMs) &&
    options.handlerRpcDeadlineMs !== undefined &&
    options.handlerRpcDeadlineMs > 0
      ? Math.floor(options.handlerRpcDeadlineMs)
      : PUBLIC_INPUT_RPC_DEADLINE_MS;

  const exchange = async (input: {
    readonly kind:
      | typeof PUBLIC_INPUT_REQUEST_KIND
      | typeof PUBLIC_INPUT_RELEASE_KIND;
    readonly workspaceId: string;
    readonly clientIdempotencyKey: string;
    readonly requestedLabel: string;
    readonly reservationRef?: string;
  }): Promise<unknown> => {
    const handler = platformExtensionCredentialHandler(env, route.handlerKey);
    if (!handler?.exchangeProviderPublicInput) {
      logPublicInputExchangeFailure("handler_unavailable");
      return undefined;
    }
    let exchanged: { readonly status: number; readonly body: string };
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        handler.exchangeProviderPublicInput(
          Object.freeze({
            url,
            request: Object.freeze({
              kind: input.kind,
              providerSource: broker.providerSource,
              publicInputs: Object.freeze({
                httpEndpointUrl: Object.freeze({
                  clientIdempotencyKey: input.clientIdempotencyKey,
                  requestedSubdomain: input.requestedLabel,
                  ...(input.reservationRef === undefined
                    ? {}
                    : { reservationRef: input.reservationRef }),
                }),
              }),
              settings: broker.runCredentialSettings ?? Object.freeze({}),
            }),
            context: Object.freeze({
              authKind: PUBLIC_INPUT_AUTH_KIND as typeof PUBLIC_INPUT_AUTH_KIND,
              providerSource: broker.providerSource,
              workspaceId: input.workspaceId,
            }),
          }),
        ),
        new Promise<typeof PUBLIC_INPUT_RPC_TIMEOUT>((resolve) => {
          timeout = setTimeout(
            () => resolve(PUBLIC_INPUT_RPC_TIMEOUT),
            handlerRpcDeadlineMs,
          );
        }),
      ]);
      if (result === PUBLIC_INPUT_RPC_TIMEOUT) {
        logPublicInputExchangeFailure("handler_rpc_timeout");
        return PUBLIC_INPUT_RPC_TIMEOUT;
      }
      exchanged = result;
    } catch {
      logPublicInputExchangeFailure("handler_rpc_failed");
      return undefined;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
    if (
      !isRecord(exchanged) ||
      !exactKeys(exchanged, ["body", "status"]) ||
      !Number.isSafeInteger(exchanged.status) ||
      typeof exchanged.body !== "string"
    ) {
      logPublicInputExchangeFailure("envelope_invalid");
      return undefined;
    }
    if ((exchanged.status as number) < 200 || (exchanged.status as number) > 299) {
      // Non-2xx is fail-closed by construction: the caller receives no origin
      // and the lane stops. Only the non-secret HTTP boundary is logged.
      logPublicInputExchangeFailure(
        "handler_response_failed",
        exchanged.status as number,
      );
      return undefined;
    }
    const bytes = new TextEncoder().encode(exchanged.body);
    if (bytes.byteLength > MAX_RESPONSE_BYTES) {
      logPublicInputExchangeFailure("response_too_large");
      return undefined;
    }
    try {
      return JSON.parse(exchanged.body) as unknown;
    } catch {
      logPublicInputExchangeFailure("response_malformed");
      return undefined;
    }
  };

  const port: PlatformExtensionCapsulePublicOriginPort = {
    async resolve({ capsule, installConfig }) {
      const clientIdempotencyKey = await capsulePublicOriginIdempotencyKey(
        capsule,
      );
      const held = heldReservation(await ledger.read(capsule.id));
      const requestedLabel = held
        ? held.requestedLabel
        : capsulePublicOriginRequestedLabel({ capsule, installConfig });
      const exchanged = await exchange({
        kind: PUBLIC_INPUT_REQUEST_KIND,
        workspaceId: capsule.workspaceId,
        clientIdempotencyKey,
        requestedLabel,
        // Presence of the reference is what distinguishes "fix me an origin"
        // from "tell me the origin you already fixed". Plan must not burn a
        // second reservation, and Apply must never quietly obtain a new one.
        ...(held ? { reservationRef: held.reservationRef } : {}),
      });
      if (exchanged === PUBLIC_INPUT_RPC_TIMEOUT) return undefined;
      const reserved = publicOriginReservation(exchanged);
      if (!reserved) return undefined;
      if (held) {
        if (
          reserved.origin !== held.origin ||
          reserved.reservationRef !== held.reservationRef
        ) {
          // The host handed this origin to someone else while the plan waited.
          // Failing here keeps the pinned descriptor honest instead of
          // registering a redirect URI for an origin this Capsule lost.
          throw new TypeError(
            "capsule public origin reservation no longer matches the pinned origin",
          );
        }
        return reserved.origin;
      }
      await ledger.write(capsule.id, {
        reservationRef: reserved.reservationRef,
        origin: reserved.origin,
        requestedLabel,
        reservedAt: clock().toISOString(),
      });
      return reserved.origin;
    },

    async release({ workspaceId, capsuleId }) {
      try {
        const held = heldReservation(await ledger.read(capsuleId));
        if (!held) return;
        const released = publicOriginRelease(
          await exchange({
            kind: PUBLIC_INPUT_RELEASE_KIND,
            workspaceId,
            clientIdempotencyKey: await capsulePublicOriginIdempotencyKey({
              id: capsuleId,
              workspaceId,
            }),
            requestedLabel: held.requestedLabel,
            reservationRef: held.reservationRef,
          }),
          held.reservationRef,
        );
        // Only a confirmed release retires the record: marking a reference the
        // host still holds as released would leak the origin with nothing left
        // able to release it.
        if (released) {
          await ledger.write(capsuleId, {
            ...held,
            releasedAt: clock().toISOString(),
          });
        }
      } catch {
        logPublicInputExchangeFailure("release_failed");
      }
    },
  };
  return Object.freeze(port);
}

function brokerAnswersPublicOrigin(
  broker: PlatformExtensionProviderCredentialBroker | undefined,
): boolean {
  return Boolean(
    broker?.publicInputExchangePath &&
      (broker.publicInputCapabilities === undefined ||
        broker.publicInputCapabilities.includes(PUBLIC_INPUT_CAPABILITY)),
  );
}

/**
 * The label Takosumi asks the host to reserve.
 *
 * It is the reviewed service name the installer already saw, scoped to the
 * Workspace. Scoping is not decoration: a reservation is unique per host, and
 * the reviewed name of a popular app is the same string in every Workspace, so
 * an unscoped label would make the second installer collide with the first.
 */
export function capsulePublicOriginRequestedLabel(input: {
  readonly capsule: Pick<Capsule, "name" | "slug" | "workspaceId">;
  readonly installConfig: Pick<
    InstallConfig,
    "installExperience" | "variableMapping"
  >;
}): string {
  const variable = installExperienceServiceNameVariable(
    input.installConfig.installExperience,
  );
  const reviewed = variable
    ? input.installConfig.variableMapping[variable]
    : undefined;
  const base = capsuleSlug(
    typeof reviewed === "string" && reviewed.trim()
      ? reviewed
      : input.capsule.slug || input.capsule.name,
  );
  const suffix = workspaceSlugSuffix(input.capsule.workspaceId);
  const label =
    !suffix || base === suffix || base.endsWith(`-${suffix}`)
      ? base
      : `${base}-${suffix}`;
  if (!REQUESTED_LABEL.test(label)) {
    throw new TypeError("capsule public origin requested label is invalid");
  }
  return label;
}

/**
 * Capsule-stable idempotency key.
 *
 * It deliberately excludes the InstallConfig: an update that adopts a new
 * immutable InstallConfig must not move the Capsule's origin, exactly as the
 * v2 OIDC client derivation is Capsule-stable
 * ({@link ./runtime_binding_materializer.ts}). Moving it would rotate the key,
 * orphan the reservation, and drift the registered redirect URI.
 */
async function capsulePublicOriginIdempotencyKey(
  capsule: Pick<Capsule, "id" | "workspaceId">,
): Promise<string> {
  const preimage = [
    PUBLIC_INPUT_IDEMPOTENCY_DOMAIN,
    capsule.workspaceId,
    capsule.id,
  ].join("\u0000");
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(preimage)),
  );
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return `endpoint_request_${hex}`;
}

function publicOriginReservation(
  value: unknown,
): { readonly origin: string; readonly reservationRef: string } | undefined {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["kind", "publicInputs"]) ||
    value.kind !== PUBLIC_INPUT_RESERVATION_KIND ||
    !isRecord(value.publicInputs) ||
    !exactKeys(value.publicInputs, ["httpEndpointUrl", "reservationRef"])
  ) {
    logPublicInputExchangeFailure("response_malformed");
    return undefined;
  }
  const reservationRef = value.publicInputs.reservationRef;
  const httpEndpointUrl = value.publicInputs.httpEndpointUrl;
  if (
    typeof reservationRef !== "string" ||
    reservationRef.length === 0 ||
    reservationRef.length > 128 ||
    /[\u0000-\u001f\u007f]/u.test(reservationRef) ||
    typeof httpEndpointUrl !== "string"
  ) {
    logPublicInputExchangeFailure("response_malformed");
    return undefined;
  }
  let origin: string;
  try {
    origin = exactHttpsOrigin(httpEndpointUrl);
  } catch {
    logPublicInputExchangeFailure("response_malformed");
    return undefined;
  }
  return { origin, reservationRef };
}

function publicOriginRelease(value: unknown, reservationRef: string): boolean {
  return (
    isRecord(value) &&
    exactKeys(value, ["kind", "reservationRef", "status"]) &&
    value.kind === PUBLIC_INPUT_RELEASED_KIND &&
    value.status === "released" &&
    value.reservationRef === reservationRef
  );
}

function logPublicInputExchangeFailure(stage: string, status?: number): void {
  console.warn(
    JSON.stringify({
      event: "platform_extension_provider_public_input_exchange_failed",
      stage,
      ...(status === undefined ? {} : { status }),
    }),
  );
}

function platformExtensionCredentialHandler(
  env: object,
  handlerKey: string,
): PlatformExtensionCredentialHandler | undefined {
  const value = (env as Record<string, unknown>)[handlerKey];
  return value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (typeof (value as { exchangeProviderCredential?: unknown })
      .exchangeProviderCredential === "function" ||
      typeof (value as { exchangeProviderPublicInput?: unknown })
        .exchangeProviderPublicInput === "function" ||
      typeof (value as { fetchAuthenticated?: unknown }).fetchAuthenticated ===
        "function")
    ? (value as PlatformExtensionCredentialHandler)
    : undefined;
}

function exactHttpsOrigin(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError(
      "TAKOSUMI_ACCOUNTS_ISSUER is required for provider credential brokers",
    );
  }
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new TypeError(
      "TAKOSUMI_ACCOUNTS_ISSUER must be an exact HTTPS origin",
    );
  }
  return url.origin;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return (
    JSON.stringify(Object.keys(value).sort()) ===
    JSON.stringify([...keys].sort())
  );
}
