/**
 * Connections domain: Takosumi-provided defaults + provider binding
 * resolution.
 *
 * An Installation binds each required OpenTofu provider through its internal
 * provider-binding record:
 *
 *   - `default`    -> the instance-wide operator default connection
 *   - `connection` -> an explicit Connection (space-scoped to the
 *                     installation's Space, or operator-scoped)
 *   - `manual`     -> operator/user-provided values (no connection; the values
 *                     become module inputs, never credentials)
 *   - `disabled`   -> the provider is unavailable
 *
 * Resolution is pure lookup — the vault still decides per-phase what a
 * resolved connection may mint (invariants 3-5), and never trusts the caller.
 */
import type {
  Connection,
  InstallConfig,
  Installation,
} from "@takosumi/internal/deploy-control-api";
import type {
  ProviderBinding,
  OperatorConnectionDefault,
  ManagedDefaultStatus,
} from "takosumi-contract/provider-bindings";
import { providerEnvRule } from "takosumi-contract/provider-env-rules";
import type { OpenTofuDeploymentStore } from "../deploy-control/store.ts";
import { OpenTofuControllerError } from "../deploy-control/errors.ts";

/** One provider binding's resolution outcome. */
export interface ResolvedProviderBinding {
  readonly provider: string;
  readonly alias?: string;
  readonly mode: ProviderBinding["mode"];
  /** Present for `connection` mode and for `default` with an operator default. */
  readonly connection?: Connection;
  /** Present for `manual` mode. */
  readonly values?: Readonly<Record<string, unknown>>;
}

export interface ConnectionsServiceDependencies {
  readonly store: OpenTofuDeploymentStore;
  readonly newId?: (prefix: string) => string;
  readonly now?: () => string;
}

export interface PutOperatorConnectionDefaultRequest {
  readonly provider?: string;
  readonly connectionId: string;
}

export class ConnectionsService {
  readonly #store: OpenTofuDeploymentStore;
  readonly #newId: (prefix: string) => string;
  readonly #now: () => string;

  constructor(dependencies: ConnectionsServiceDependencies) {
    this.#store = dependencies.store;
    this.#newId = dependencies.newId ??
      ((prefix) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`);
    this.#now = dependencies.now ?? (() => new Date().toISOString());
  }

  /**
   * Sets the instance-wide Takosumi-provided default connection for one provider.
   * The connection must exist and be operator-scoped: a space connection is
   * one Space's credential and must never become an instance-wide default.
   */
  async putOperatorConnectionDefault(
    request: PutOperatorConnectionDefaultRequest,
  ): Promise<OperatorConnectionDefault> {
    const connection = await this.#store.getConnection(request.connectionId);
    if (!connection) {
      throw new OpenTofuControllerError(
        "not_found",
        `connection ${request.connectionId} not found`,
      );
    }
    if (connection.scope !== "operator") {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `connection ${request.connectionId} is space-scoped; operator defaults ` +
          `require an operator-scoped connection`,
      );
    }
    const now = this.#now();
    return await this.#store.putOperatorConnectionDefault({
      id: this.#newId("ocd"),
      provider: request.provider ?? connection.provider,
      connectionId: connection.id,
      createdAt: now,
      updatedAt: now,
    });
  }

  async listOperatorConnectionDefaults(): Promise<
    readonly OperatorConnectionDefault[]
  > {
    return await this.#store.listOperatorConnectionDefaults();
  }

  /**
   * Non-secret read of whether THIS instance's managed default (the operator
   * key) can cover an install that configures NO Space connection (spec §7.1
   * `takosumi_managed` default). An empty / `default`-mode ProviderBinding falls
   * through to the operator default for its provider, so the dashboard uses this
   * to decide whether to nudge the user to "connect your own cloud first" — it
   * should only nudge when the managed default is NOT available.
   *
   * The projection is intentionally credential-free: it reads the operator
   * defaults but returns ONLY a boolean and the covered provider source names.
   * The operator default's id / connectionId / secret material NEVER leave this
   * method — they stay on the bearer-gated §30 surface. Binding resolution
   * (`resolveProviderBindings`) is unaffected.
   */
  async getManagedDefaultStatus(): Promise<ManagedDefaultStatus> {
    const defaults = await this.#store.listOperatorConnectionDefaults();
    const providers = [
      ...new Set(defaults.map((entry) => entry.provider)),
    ].sort((a, b) => a.localeCompare(b));
    return { available: providers.length > 0, providers };
  }

  /**
   * Resolves the EXPLICIT provider bindings recorded in an Installation's
   * DeploymentProfile. Unbound required providers are NOT synthesized here; the
   * run-scoped {@link resolveProviderBindingsForRun} adds the operator-default
   * fall-through once the run's required providers are known.
   */
  async resolveProviderBindings(
    installation: Installation,
  ): Promise<readonly ResolvedProviderBinding[]> {
    const profile = await this.#store.getDeploymentProfileByInstallation(
      installation.id,
      installation.environment,
    );
    return await Promise.all(
      (profile?.bindings ?? []).map((binding) =>
        this.#resolveBinding(installation, binding)
      ),
    );
  }

  /**
   * Run-scoped provider binding resolution: the EXPLICIT DeploymentProfile
   * bindings PLUS the documented operator-default fall-through (spec §7.1
   * `takosumi_managed`, ProviderBinding contract: "an empty ProviderBindings
   * list ALWAYS resolves to `default` and falls through to the operator key").
   *
   * For every provider the run requires that has NO explicit binding of any
   * mode, this synthesizes a `default` binding so the managed default (the
   * operator key) covers an install that configured no Space connection. The
   * synthesis is keyed by the operator default's OWN provider name so the
   * subsequent exact-match lookup succeeds even when `requiredProviders` carries
   * canonical registry addresses (e.g. `registry.opentofu.org/cloudflare/
   * cloudflare`) while the operator default is registered under the short name
   * (`cloudflare`). It is fail-closed: a required provider with no operator
   * default (and no explicit binding) contributes nothing, so no credential is
   * minted for it.
   *
   * Both the generated-root provider blocks and the per-alias credential mint
   * derive from this same resolution, so the rootgen `TF_VAR_<provider>_<arg>`
   * variables and the minted values line up byte-for-byte.
   */
  async resolveProviderBindingsForRun(
    installation: Installation,
    requiredProviders: readonly string[],
  ): Promise<readonly ResolvedProviderBinding[]> {
    const explicit = await this.resolveProviderBindings(installation);
    if (requiredProviders.length === 0) return explicit;
    const operatorDefaults = await this.#store.listOperatorConnectionDefaults();
    const synthesized: ResolvedProviderBinding[] = [];
    const seen = new Set<string>();
    for (const required of requiredProviders) {
      // Respect any explicit binding for the provider (default / connection /
      // manual / disabled): the user's configuration wins over the fall-through.
      if (explicit.some((entry) => providersMatch(required, entry.provider))) {
        continue;
      }
      const match = operatorDefaults.find((entry) =>
        providersMatch(required, entry.provider)
      );
      // Fail closed: no operator default for this provider -> no credential.
      if (!match) continue;
      // Synthesize at most one default binding per operator-default provider.
      if (seen.has(match.provider)) continue;
      seen.add(match.provider);
      synthesized.push(
        await this.#resolveBinding(installation, {
          provider: match.provider,
          mode: "default",
        }),
      );
    }
    return synthesized.length === 0 ? explicit : [...explicit, ...synthesized];
  }

  async #resolveBinding(
    installation: Installation,
    binding: ProviderBinding,
  ): Promise<ResolvedProviderBinding> {
    switch (binding.mode) {
      case "disabled":
        return {
          provider: binding.provider,
          ...(binding.alias ? { alias: binding.alias } : {}),
          mode: "disabled",
        };
      case "manual":
        return {
          provider: binding.provider,
          ...(binding.alias ? { alias: binding.alias } : {}),
          mode: "manual",
          values: binding.values ?? {},
        };
      case "connection": {
        if (!binding.connectionId) {
          throw new OpenTofuControllerError(
            "failed_precondition",
            `provider ${binding.provider} binds mode "connection" without a connectionId`,
          );
        }
        const connection = await this.#store.getConnection(binding.connectionId);
        if (!connection) {
          throw new OpenTofuControllerError(
            "not_found",
            `connection ${binding.connectionId} (provider ${binding.provider}) not found`,
          );
        }
        // A space connection must belong to the installation's Space; an
        // operator connection is usable from any Space.
        if (
          connection.scope === "space" &&
          connection.spaceId !== installation.spaceId
        ) {
          throw new OpenTofuControllerError(
            "permission_denied",
            `connection ${binding.connectionId} belongs to another space`,
          );
        }
        return {
          provider: binding.provider,
          ...(binding.alias ? { alias: binding.alias } : {}),
          mode: "connection",
          connection,
        };
      }
      case "default": {
        const fallback = await this.#store.getOperatorConnectionDefault(
          binding.provider,
        );
        if (!fallback) {
          return {
            provider: binding.provider,
            ...(binding.alias ? { alias: binding.alias } : {}),
            mode: "default",
          };
        }
        const connection = await this.#store.getConnection(fallback.connectionId);
        return {
          provider: binding.provider,
          ...(binding.alias ? { alias: binding.alias } : {}),
          mode: "default",
          ...(connection ? { connection } : {}),
        };
      }
    }
    throw new OpenTofuControllerError(
      "invalid_argument",
      `unknown provider binding mode ${(binding as { mode?: string }).mode}`,
    );
  }
}

/**
 * Collects the connection ids a run's credential mint may draw from: the
 * resolved `connection` / `default` provider bindings. `manual` contributes module
 * values (not credentials) and `disabled` contributes nothing.
 */
export function mintableConnectionIds(
  resolved: readonly ResolvedProviderBinding[],
): readonly string[] {
  const ids = new Set<string>();
  for (const entry of resolved) {
    if (entry.connection) ids.add(entry.connection.id);
  }
  return [...ids];
}

/**
 * True when two provider identifiers name the same OpenTofu provider, matching
 * a short name (`cloudflare`) against a canonical registry address
 * (`registry.opentofu.org/cloudflare/cloudflare`) through the shared
 * provider-env-rule table. Mirrors the vault's `providerMatches` so the
 * operator-default fall-through keys consistently with credential mint.
 */
function providersMatch(left: string, right: string): boolean {
  if (left === right) return true;
  const lrule = providerEnvRule(left);
  const rrule = providerEnvRule(right);
  return lrule !== undefined && lrule === rrule;
}

export function createConnectionsService(
  dependencies: ConnectionsServiceDependencies,
): ConnectionsService {
  return new ConnectionsService(dependencies);
}

// Re-exported so route/service composition can validate InstallConfig usage
// alongside capability resolution without importing the store types directly.
export type { ProviderBinding, InstallConfig };
