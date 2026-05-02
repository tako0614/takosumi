// PlanService adapter over `DeploymentService.resolveDeployment`.

import type {
  Deployment,
  DeploymentInput,
  IsoTimestamp,
} from "takosumi-contract";
import {
  type DeploymentFilter,
  DeploymentService,
  type DeploymentServiceOptions,
  type DeploymentStore,
  type ResolveDeploymentInput,
} from "./deployment_service.ts";
import type { DeployBlocker, PublicDeployManifest } from "./types.ts";

export interface PlanServiceOptions
  extends Omit<DeploymentServiceOptions, "store"> {
  store?: DeploymentStore;
  blockerProvider?: DeploymentPlanBlockerProvider;
}

export interface DeploymentPlanBlockerProviderInput {
  readonly spaceId: string;
  readonly groupId: string;
  readonly manifest: PublicDeployManifest;
  readonly createdAt: IsoTimestamp;
}

export type DeploymentPlanBlockerProvider = (
  input: DeploymentPlanBlockerProviderInput,
) => readonly DeployBlocker[] | Promise<readonly DeployBlocker[]>;

export interface CreateDeploymentPlanInput {
  spaceId: string;
  manifest: PublicDeployManifest;
  env?: string;
  envName?: string;
  input?: DeploymentInput;
  id?: string;
  createdAt?: IsoTimestamp;
  blockers?: readonly DeployBlocker[];
}

/** Resolves a Deployment via `DeploymentService`. */
export class PlanService {
  readonly #service?: DeploymentService;
  readonly #blockerProvider?: DeploymentPlanBlockerProvider;
  readonly #clock: () => Date;
  readonly #idFactory: () => string;
  readonly #store?: DeploymentStore;

  constructor(options: PlanServiceOptions = {}) {
    this.#store = options.store;
    this.#clock = options.clock ?? (() => new Date());
    this.#idFactory = options.idFactory ?? (() => crypto.randomUUID());
    this.#blockerProvider = options.blockerProvider;
    if (options.store) {
      this.#service = new DeploymentService({
        store: options.store,
        clock: this.#clock,
        idFactory: this.#idFactory,
      });
    }
  }

  async createPlan(input: CreateDeploymentPlanInput): Promise<Deployment> {
    if (!this.#service) {
      throw new Error(
        "PlanService.createPlan requires a `store` to be configured",
      );
    }
    const createdAt = input.createdAt ?? this.#clock().toISOString();
    const providerBlockers = await this.#blockerProvider?.({
      spaceId: input.spaceId,
      groupId: input.manifest.name,
      manifest: input.manifest,
      createdAt,
    }) ?? [];
    const resolveInput: ResolveDeploymentInput = {
      spaceId: input.spaceId,
      manifest: input.manifest,
      env: input.env,
      envName: input.envName,
      input: input.input,
      id: input.id,
      createdAt,
      blockers: dedupeBlockers([
        ...(input.blockers ?? []),
        ...providerBlockers,
      ]),
    };
    return await this.#service.resolveDeployment(resolveInput);
  }

  async getDeployment(id: string): Promise<Deployment | undefined> {
    return await this.#service?.getDeployment(id);
  }

  async listDeployments(
    filter: DeploymentFilter = {},
  ): Promise<readonly Deployment[]> {
    return (await this.#service?.listDeployments(filter)) ?? [];
  }
}

/**
 * Stable read-set key for a group activation pointer. Preserved for
 * `apply_service.ts` and store call-sites that key per-group state by this
 * string.
 */
export function groupActivationReadSetKey(
  spaceId: string,
  groupId: string,
): string {
  return `group_activation:${spaceId}:${groupId}`;
}

function dedupeBlockers(
  blockers: readonly DeployBlocker[],
): readonly DeployBlocker[] {
  const seen = new Set<string>();
  const output: DeployBlocker[] = [];
  for (const blocker of blockers) {
    const key = `${blocker.source}:${blocker.code}:${blocker.subject ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(blocker);
  }
  return output;
}
