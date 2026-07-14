/**
 * Pre-dispatch plan resolution: the "what to run" computation that turns a plan
 * request + ProviderBinding + Capsule into the resolved provider context before
 * a run is dispatched.
 *
 * A cohesive collaborator pulled out of `OpenTofuController`: it owns
 * provider aliases and non-secret provider configuration.
 *
 * These transform a plan request into the resolved providers / generated root
 * BEFORE the run is dispatched; the run dispatch + the per-phase credential mint
 * + the policy engine stay on the controller (they are coupled to the run-engine
 * mutation path). Behavior is identical to the prior inline controller methods:
 * exact signatures, error codes (`invalid_argument` / `failed_precondition` with
 * the same messages), and ordering are preserved.
 *
 * The provider resolution dependency is threaded in as a port:
 *   - `resolveCapsuleProviderBindingsForRun` — delegates to the controller's lazily
 *     constructed {@link ConnectionsService} so the SAME instance resolves the
 *     run-scoped Provider Bindings for rootgen here and for credential
 *     mint at run time.
 */

import type { JsonValue } from "takosumi-contract";
import type { Capsule } from "@takosumi/internal/deploy-control-api";
import type { RootProviderBinding } from "takosumi-rootgen";
import type { ResolvedCapsuleProviderBinding } from "../connections/mod.ts";
import { canonicalProviderAddress } from "./provider_policy.ts";
import { OpenTofuControllerError } from "./errors.ts";
import { normalizeProviders } from "./validation.ts";
import { normalizeManagedPublicBaseDomain } from "./managed_public_domains.ts";
import { isPublicManagedProviderConnection } from "takosumi-contract/connections";

/**
 * Provider context for a Capsule plan. A generated child-module wrapper is
 * needed only when an explicit alias or non-secret provider configuration must
 * be represented in HCL.
 */
export interface CapsulePlanContext {
  /** Provider mapping derived from the resolved Provider Bindings. */
  readonly providerBindings: readonly RootProviderBinding[];
  /**
   * Fully-qualified provider addresses derived from resolved ProviderBindings,
   * from explicit ProviderBindings.
   */
  readonly requiredProvidersFromBindings: readonly string[];
  /**
   * Non-secret provider scope metadata available to fill requested Capsule
   * inputs. The controller only applies these defaults under keys already
   * declared by InstallConfig.variableMapping; Provider Connections must not
   * invent module input schema for arbitrary OpenTofu Capsules.
   */
  readonly providerInputDefaults: Readonly<Record<string, JsonValue>>;
  /** Public namespace advertised by the selected managed target, if any. */
  readonly managedPublicBaseDomain?: string;
}

/**
 * Ports the controller injects into {@link PlanResolutionService}.
 * `resolveCapsuleProviderBindingsForRun` delegates to
 * the controller's lazily constructed {@link ConnectionsService} so the SAME
 * instance resolves the run-scoped Provider Bindings here and on the mint
 * path.
 */
export interface PlanResolutionServiceDependencies {
  /**
   * Run-scoped Provider Binding resolution. The controller passes the subset
   * of required providers that need Takosumi-managed credential material; other
   * providers may run without env/file injection or with explicit generic-env
   * bindings.
   * Delegates to the controller's shared {@link ConnectionsService}.
   */
  readonly resolveCapsuleProviderBindingsForRun: (
    capsule: Capsule,
    requiredProviders: readonly string[],
  ) => Promise<readonly ResolvedCapsuleProviderBinding[]>;
}

/**
 * Collaborator owning provider context derivation and Cloud-only
 * materialization rejection.
 */
export class PlanResolutionService {
  readonly #resolveCapsuleProviderBindingsForRun: (
    capsule: Capsule,
    requiredProviders: readonly string[],
  ) => Promise<readonly ResolvedCapsuleProviderBinding[]>;

  constructor(dependencies: PlanResolutionServiceDependencies) {
    this.#resolveCapsuleProviderBindingsForRun =
      dependencies.resolveCapsuleProviderBindingsForRun;
  }

  /**
   * Derives provider aliases/configuration from the Capsule's resolved
   * explicit ProviderBindings.
   * Provider Bindings resolve through the {@link ConnectionsService} so
   * connection changes take effect on the next plan.
   */
  async resolveCapsulePlan(
    capsule: Capsule,
    credentialRequiredProviders: readonly string[],
  ): Promise<CapsulePlanContext> {
    // Run-scoped resolution so generated-root provider blocks come from the
    // reviewed ProviderBinding records.
    // The caller filters the full required provider set down to providers that
    // require credential material; no-credential providers remain on
    // PlanRun.requiredProviders but do not force a ProviderConnection.
    const resolved = await this.#resolveCapsuleProviderBindingsForRun(
      capsule,
      credentialRequiredProviders,
    );
    const providerBindings = providerBindingsFromResolved(resolved);
    const providerInputDefaults = providerInputDefaultsFromResolved(resolved);
    const managedPublicBaseDomain =
      managedPublicBaseDomainFromResolved(resolved);
    return {
      providerBindings,
      requiredProvidersFromBindings: requiredProvidersFromResolved(resolved),
      providerInputDefaults,
      ...(managedPublicBaseDomain ? { managedPublicBaseDomain } : {}),
    };
  }
}

function managedPublicBaseDomainFromResolved(
  resolved: readonly ResolvedCapsuleProviderBinding[],
): string | undefined {
  const domains = new Set<string>();
  for (const entry of resolved) {
    if (
      !entry.connection ||
      !isPublicManagedProviderConnection(entry.connection)
    ) {
      continue;
    }
    const domain = normalizeManagedPublicBaseDomain(
      entry.connection.scopeHints?.managedPublicBaseDomain,
    );
    if (domain) domains.add(domain);
  }
  if (domains.size > 1) {
    throw new OpenTofuControllerError(
      "failed_precondition",
      "managed Provider Connections disagree on the public base domain",
    );
  }
  return domains.values().next().value as string | undefined;
}

export function providerBindingsFromResolved(
  resolved: readonly ResolvedCapsuleProviderBinding[],
): readonly RootProviderBinding[] {
  const providers: RootProviderBinding[] = [];
  for (const entry of resolved) {
    const provider = entry.provider;
    const configuration = entry.connection?.scopeHints?.providerConfig;
    providers.push({
      provider,
      ...(entry.alias ? { alias: entry.alias } : {}),
      ...(configuration && Object.keys(configuration).length > 0
        ? { configuration }
        : {}),
    });
  }
  return providers;
}

function requiredProvidersFromResolved(
  resolved: readonly ResolvedCapsuleProviderBinding[],
): readonly string[] {
  return normalizeProviders(
    resolved.map((entry) =>
      canonicalProviderAddress(entry.connection.providerSource),
    ),
  );
}

function providerInputDefaultsFromResolved(
  resolved: readonly ResolvedCapsuleProviderBinding[],
): Readonly<Record<string, JsonValue>> {
  const inputs: Record<string, JsonValue> = {};
  for (const entry of resolved) {
    const connection = entry.connection;
    if (!connection) continue;
    for (const [key, value] of Object.entries(
      connection.scopeHints?.moduleInputDefaults ?? {},
    )) {
      const existing = inputs[key];
      if (existing !== undefined && !sameJsonValue(existing, value)) {
        throw new OpenTofuControllerError(
          "failed_precondition",
          `provider module input default ${key} conflicts across Provider Connections`,
        );
      }
      inputs[key] = value;
    }
  }
  return inputs;
}

function sameJsonValue(left: JsonValue, right: JsonValue): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
