/**
 * Deployment / Installation read-projection facade.
 *
 * A thin collaborator pulled out of `OpenTofuDeploymentController`: every method
 * is a read-only projection over the {@link OpenTofuDeploymentStore} (no
 * mutation, no run-execution coupling, no credential mint). The controller holds
 * one instance and re-exposes these on its public API unchanged, so the `/api`
 * installation / ledger route layers keep calling the controller surface.
 *
 * `requireInstallation` is exported so the controller's run-execution path can
 * keep using the single typed `not_found` guard without duplicating it.
 */

import type { JsonValue } from "takosumi-contract";
import type {
  ApplyRunResponse,
  Deployment,
  GetInstallationResponse,
  Installation,
  ListDeploymentsResponse,
  ListDeploymentOutputsResponse,
} from "@takosumi/internal/deploy-control-api";
import type { PublicInstallation } from "takosumi-contract/installations";
import type { OpenTofuDeploymentStore } from "./store.ts";
import { OpenTofuControllerError, requireNonEmptyString } from "./errors.ts";

/**
 * Projects a stored {@link Installation} to its public shape (stripping the
 * internal `installType` seam). Injected by the controller so the projection
 * stays owned in exactly one place; `getApplyRun` / `getInstallation` apply it
 * to match the `PublicInstallation`-typed response contracts.
 */
export type PublicInstallationProjector = (
  installation: Installation,
) => PublicInstallation;

/**
 * Resolves an Installation by id or throws a typed `not_found`. Shared by the
 * deployment-query facade and the controller's run-execution path so the guard
 * lives in exactly one place.
 */
export async function requireInstallation(
  store: OpenTofuDeploymentStore,
  id: string,
): Promise<Installation> {
  requireNonEmptyString(id, "installationId");
  const installation = await store.getInstallation(id);
  if (!installation) {
    throw new OpenTofuControllerError(
      "not_found",
      `installation ${id} not found`,
    );
  }
  return installation;
}

/** Read-only Deployment / Installation projections over the store. */
export class DeploymentQuery {
  readonly #store: OpenTofuDeploymentStore;
  readonly #publicInstallation: PublicInstallationProjector;

  constructor(
    store: OpenTofuDeploymentStore,
    publicInstallation: PublicInstallationProjector,
  ) {
    this.#store = store;
    this.#publicInstallation = publicInstallation;
  }

  async getApplyRun(id: string): Promise<ApplyRunResponse> {
    requireNonEmptyString(id, "applyRunId");
    const applyRun = await this.#store.getApplyRun(id);
    if (!applyRun) {
      throw new OpenTofuControllerError("not_found", `apply run ${id} not found`);
    }
    const installation = applyRun.installationId
      ? await this.#store.getInstallation(applyRun.installationId)
      : undefined;
    const deployment = applyRun.deploymentId
      ? await this.#store.getDeployment(applyRun.deploymentId)
      : undefined;
    return {
      applyRun,
      ...(installation
        ? { installation: this.#publicInstallation(installation) }
        : {}),
      ...(deployment ? { deployment } : {}),
    };
  }

  async getInstallation(id: string): Promise<GetInstallationResponse> {
    return {
      installation: this.#publicInstallation(
        await requireInstallation(this.#store, id),
      ),
    };
  }

  /**
   * Lists ACTIVE Installations across all Spaces, capped at `limit` (spec §28
   * scheduled drift sweep; Phase 8). Only `active` Installations are drift-checkable
   * (a `pending` / `disabled` / `destroyed` / `error` Installation has no
   * stable deployed state to compare against). The scheduled sweep iterates this
   * bounded set and creates one drift check per Installation. A non-positive
   * limit returns an empty list.
   */
  async listActiveInstallations(
    limit: number,
  ): Promise<readonly Installation[]> {
    if (!Number.isFinite(limit) || limit <= 0) return [];
    const all = await this.#store.listInstallations();
    return all.filter((i) => i.status === "active").slice(0, Math.floor(limit));
  }

  async listDeployments(
    installationId: string,
  ): Promise<ListDeploymentsResponse> {
    await requireInstallation(this.#store, installationId);
    return {
      deployments: await this.#store.listDeployments(installationId),
    };
  }

  async listDeploymentOutputs(
    installationId: string,
  ): Promise<ListDeploymentOutputsResponse> {
    const installation = await requireInstallation(this.#store, installationId);
    if (!installation.currentDeploymentId) return { outputs: [] };
    const deployment = await this.#store.getDeployment(
      installation.currentDeploymentId,
    );
    const outputsPublic = deployment?.outputsPublic ?? {};
    return {
      outputs: Object.entries(outputsPublic).map(([name, value]) => ({
        name,
        kind: name,
        value: value as JsonValue,
        sensitive: false,
      })),
    };
  }

  /**
   * Reads a single Deployment ledger record (spec §21 / §30 `GET
   * /api/deployments/:id`). A missing id is a typed 404.
   */
  async getDeployment(id: string): Promise<Deployment> {
    requireNonEmptyString(id, "deploymentId");
    const deployment = await this.#store.getDeployment(id);
    if (!deployment) {
      throw new OpenTofuControllerError(
        "not_found",
        `deployment ${id} not found`,
      );
    }
    return deployment;
  }
}
