/**
 * Connections domain: Provider Env binding resolution.
 *
 * Connection rows remain the low-level sealed material/OAuth/source-credential
 * substrate. OpenTofu provider execution is bound through vault-backed Provider
 * Env rows (`oauth` or `secret`). Takosumi Cloud compatibility gateways and
 * managed-resource backends are closed Cloud extensions, not OSS resolver
 * materializations.
 */
import type {
  Connection,
  Installation,
} from "@takosumi/internal/deploy-control-api";
import { randomUUID } from "node:crypto";
import type {
  InstallationProviderEnvBinding,
  InstallationProviderEnvBindings,
  PutProviderEnvRequest,
  ProviderEnv,
} from "takosumi-contract/provider-envs";
import {
  isProviderEnvMaterialization,
  PROVIDER_ENV_STATUSES,
  type ProviderEnvStatus,
} from "takosumi-contract/provider-envs";
import { sameProviderFamily } from "takosumi-contract/provider-env-rules";
import { stableJsonDigest } from "../../adapters/source/digest.ts";
import { OpenTofuControllerError } from "../deploy-control/errors.ts";
import type { OpenTofuDeploymentStore } from "../deploy-control/store.ts";

/** One Provider Env binding's resolution outcome. */
export interface ResolvedInstallationProviderEnvBinding {
  readonly provider: string;
  readonly alias?: string;
  readonly env: ProviderEnv;
  readonly materialization: ProviderEnv["materialization"];
  readonly connection?: Connection;
}

export function validateInstallationProviderEnvBindings(
  value: unknown,
  field = "providerEnvBindings",
): InstallationProviderEnvBindings {
  if (!Array.isArray(value)) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      `${field} must be an array`,
    );
  }
  return value.map((entry, index) =>
    validateInstallationProviderEnvBinding(entry, `${field}[${index}]`),
  );
}

function validateInstallationProviderEnvBinding(
  value: unknown,
  field: string,
): InstallationProviderEnvBinding {
  if (!isRecord(value)) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      `${field} must be an object`,
    );
  }
  const provider = nonEmptyField(value.provider, `${field}.provider`);
  const envId = nonEmptyField(value.envId, `${field}.envId`);
  const alias =
    value.alias === undefined
      ? undefined
      : nonEmptyField(value.alias, `${field}.alias`);
  const region =
    value.region === undefined
      ? undefined
      : nonEmptyField(value.region, `${field}.region`);
  return {
    provider,
    envId,
    ...(alias ? { alias } : {}),
    ...(region ? { region } : {}),
  };
}

function nonEmptyField(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      `${field} must be a non-empty string`,
    );
  }
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Stable digest over a run's resolved Provider Env bindings.
 */
export async function resolvedProviderEnvBindingsDigest(
  resolved: readonly ResolvedInstallationProviderEnvBinding[] | undefined,
): Promise<string> {
  const entries = (resolved ?? [])
    .map((entry) => ({
      provider: entry.provider,
      alias: entry.alias ?? null,
      envId: entry.env.id,
      materialization: entry.env.materialization,
      status: entry.env.status,
      connectionId: entry.connection?.id ?? null,
      envNames: [...entry.env.requiredEnvNames].sort(),
    }))
    .sort(
      (a, b) =>
        a.provider.localeCompare(b.provider) ||
        String(a.alias).localeCompare(String(b.alias)),
    );
  return await stableJsonDigest(entries);
}

export interface ConnectionsServiceDependencies {
  readonly store: OpenTofuDeploymentStore;
  readonly newId?: (prefix: string) => string;
  readonly now?: () => string;
}

export class ConnectionsService {
  readonly #store: OpenTofuDeploymentStore;
  readonly #newId: (prefix: string) => string;
  readonly #now: () => string;

  constructor(dependencies: ConnectionsServiceDependencies) {
    this.#store = dependencies.store;
    this.#newId =
      dependencies.newId ??
      ((prefix) =>
        `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 24)}`);
    this.#now = dependencies.now ?? (() => new Date().toISOString());
  }

  async putProviderEnv(
    id: string | undefined,
    input: PutProviderEnvRequest,
  ): Promise<ProviderEnv> {
    const providerSource = nonEmptyField(
      input.providerSource,
      "providerSource",
    );
    const displayName = nonEmptyField(input.displayName, "displayName");
    if (!isProviderEnvMaterialization(input.materialization)) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        "materialization must be oauth or secret",
      );
    }
    let status = validateProviderEnvStatus(input.status ?? "ready");
    if (!input.spaceId) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        "provider resolver records must be scoped to a Space in OSS",
      );
    }
    if (input.secretRef) {
      const backingConnection = await this.#store.getConnection(
        input.secretRef,
      );
      if (!backingConnection) {
        throw new OpenTofuControllerError(
          "invalid_argument",
          `Provider Env backing Connection ${input.secretRef} does not exist`,
        );
      }
      if (
        input.spaceId !== undefined &&
        backingConnection.spaceId !== input.spaceId
      ) {
        throw new OpenTofuControllerError(
          "permission_denied",
          `Provider Env backing Connection ${input.secretRef} belongs to another Space`,
        );
      }
      if (
        input.status === undefined &&
        backingConnection.status !== "verified"
      ) {
        status = "needs_setup";
      }
      if (status === "ready" && backingConnection.status !== "verified") {
        throw new OpenTofuControllerError(
          "failed_precondition",
          `Provider Env backing Connection ${input.secretRef} status ${backingConnection.status} is not verified`,
        );
      }
    }
    const now = this.#now();
    const existing = id ? await this.#store.getProviderEnv(id) : undefined;
    const env: ProviderEnv = {
      id: id ?? this.#newId("penv"),
      ...(input.spaceId ? { spaceId: input.spaceId } : {}),
      providerSource,
      displayName,
      materialization: input.materialization,
      status,
      requiredEnvNames: validateStringArray(
        input.requiredEnvNames ?? [],
        "requiredEnvNames",
      ),
      ...(input.secretRef ? { secretRef: input.secretRef } : {}),
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    return await this.#store.putProviderEnv(env);
  }

  async getProviderEnv(id: string): Promise<ProviderEnv> {
    const env = await this.#store.getProviderEnv(nonEmptyField(id, "id"));
    if (!env) {
      throw new OpenTofuControllerError(
        "not_found",
        `Provider Env ${id} not found`,
      );
    }
    return env;
  }

  async listProviderEnvs(spaceId?: string): Promise<readonly ProviderEnv[]> {
    return await this.#store.listProviderEnvs(spaceId);
  }

  async resolveProviderEnvBindings(
    installation: Installation,
  ): Promise<readonly ResolvedInstallationProviderEnvBinding[]> {
    const set =
      await this.#store.getInstallationProviderEnvBindingSetByInstallation(
        installation.id,
        installation.environment,
      );
    const bindings = validateInstallationProviderEnvBindings(
      set?.bindings ?? [],
      "installation provider env binding set bindings",
    );
    return await Promise.all(
      bindings.map((binding) => this.#resolveBinding(installation, binding)),
    );
  }

  async resolveProviderEnvBindingsForRun(
    installation: Installation,
    requiredProviders: readonly string[],
  ): Promise<readonly ResolvedInstallationProviderEnvBinding[]> {
    const explicit = await this.resolveProviderEnvBindings(installation);
    if (requiredProviders.length === 0) return explicit;

    const missing = requiredProviders
      .filter(
        (required) =>
          !explicit.some((entry) =>
            sameProviderFamily(required, entry.provider),
          ),
      )
      .sort();
    if (missing.length > 0) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `provider connection is required for providers: ${missing.join(", ")}`,
      );
    }
    return explicit;
  }

  async #resolveBinding(
    installation: Installation,
    binding: InstallationProviderEnvBinding,
  ): Promise<ResolvedInstallationProviderEnvBinding> {
    const env = await this.#store.getProviderEnv(binding.envId);
    if (!env) {
      throw new OpenTofuControllerError(
        "not_found",
        `Provider Env ${binding.envId} (provider ${binding.provider}) not found`,
      );
    }
    if (env.spaceId !== undefined && env.spaceId !== installation.spaceId) {
      throw new OpenTofuControllerError(
        "permission_denied",
        `Provider Env ${binding.envId} belongs to another Space`,
      );
    }
    if (env.spaceId === undefined) {
      throw new OpenTofuControllerError(
        "permission_denied",
        `Provider Env ${binding.envId} is global and cannot be used by OSS Takosumi`,
      );
    }
    if (!sameProviderFamily(binding.provider, env.providerSource)) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `Provider Env ${binding.envId} provider ${env.providerSource} does not match binding provider ${binding.provider}`,
      );
    }
    if (env.status !== "ready") {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `Provider Env ${binding.envId} status ${env.status} is not ready`,
      );
    }
    if (!env.secretRef) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `Provider Env ${env.id} has no backing Connection reference`,
      );
    }
    const connection = await this.#store.getConnection(env.secretRef);
    if (!connection) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `Provider Env ${env.id} has no backing Connection`,
      );
    }
    if (env.spaceId !== undefined && connection.spaceId !== env.spaceId) {
      throw new OpenTofuControllerError(
        "permission_denied",
        `Provider Env ${env.id} backing Connection belongs to another Space`,
      );
    }
    if (connection.status !== "verified") {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `Provider Env ${env.id} backing Connection status ${connection.status} is not verified`,
      );
    }
    return {
      provider: binding.provider,
      ...(binding.alias ? { alias: binding.alias } : {}),
      env,
      materialization: env.materialization,
      connection,
    };
  }
}

function validateProviderEnvStatus(value: string): ProviderEnvStatus {
  if (!PROVIDER_ENV_STATUSES.includes(value as ProviderEnvStatus)) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "status must be ready, needs_setup, expired, or blocked",
    );
  }
  return value as ProviderEnvStatus;
}

function validateStringArray(
  value: readonly string[],
  field: string,
): readonly string[] {
  if (!Array.isArray(value)) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      `${field} must be an array`,
    );
  }
  return value.map((entry, index) =>
    nonEmptyField(entry, `${field}[${index}]`),
  );
}

/** Collects the connection ids a run's vault-backed credential mint may draw from. */
export function mintableConnectionIds(
  resolved: readonly ResolvedInstallationProviderEnvBinding[],
): readonly string[] {
  const ids = new Set<string>();
  for (const entry of resolved) {
    if (entry.connection) ids.add(entry.connection.id);
  }
  return [...ids];
}

export function createConnectionsService(
  dependencies: ConnectionsServiceDependencies,
): ConnectionsService {
  return new ConnectionsService(dependencies);
}

export type { InstallationProviderEnvBinding };
