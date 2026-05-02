import { createHash } from "node:crypto";
import {
  buildPublicationResolution,
  type CorePublicationResolution,
  type CorePublicationResolutionStore,
  projectPublication,
  projectPublicationResolution,
  type Publication,
  type PublicationConsumerBinding,
  type PublicationConsumerBindingStore,
  type PublicationGrant,
  type PublicationGrantStore,
  type PublicationOutput,
  type PublicationOutputInjectionApproval,
  type PublicationProjection,
  type PublicationProjectionStore,
  type PublicationStore,
} from "../../domains/publications/mod.ts";
import {
  conflict,
  invalidArgument,
  permissionDenied,
} from "../../shared/errors.ts";

export interface PublicationPlannerStores {
  readonly publications: PublicationStore;
  readonly bindings: PublicationConsumerBindingStore;
  readonly grants?: PublicationGrantStore;
  readonly resolutions?: CorePublicationResolutionStore;
  readonly projections?: PublicationProjectionStore;
}

export interface PublicationDependencyPlannerOptions {
  readonly stores: PublicationPlannerStores;
  readonly idFactory?: () => string;
  readonly clock?: () => Date;
  readonly requireCrossGroupGrant?: boolean;
}

export interface ValidateConsumerBindingInput {
  readonly binding: PublicationConsumerBinding;
  readonly candidatePublications?: readonly Publication[];
  readonly approvals?: readonly PublicationOutputInjectionApproval[];
}

export interface ValidatedConsumerBinding {
  readonly binding: PublicationConsumerBinding;
  readonly publication: Publication;
  readonly grant?: PublicationGrant;
  readonly explicitOutputNames: readonly string[];
  readonly approvalRequiredOutputNames: readonly string[];
  readonly approvedOutputNames: readonly string[];
}

export interface PlanConsumerBindingInput extends ValidateConsumerBindingInput {
  readonly projectionId?: string;
  readonly projectedAt?: string;
  readonly persist?: boolean;
}

export interface PlanConsumerBindingResult extends ValidatedConsumerBinding {
  readonly resolution: CorePublicationResolution;
  readonly projection: PublicationProjection;
}

export interface ProducerChangeRebind {
  readonly bindingId: string;
  readonly targetPublicationAddress?: string;
  readonly reason?: string;
}

export interface PlanProducerChangeInput {
  readonly previous: Publication;
  readonly next: Publication;
  readonly compatibility: "compatible" | "breaking";
  readonly consumerRebinds?: readonly ProducerChangeRebind[];
}

export interface PlanPublicationWithdrawalInput {
  readonly publication: Publication;
  readonly withdrawnAt?: string;
  readonly projectedAt?: string;
  readonly persist?: boolean;
}

export interface PublicationWithdrawalPlan {
  readonly publicationId: string;
  readonly publicationAddress: string;
  readonly affectedBindingIds: readonly string[];
  readonly projections: readonly PublicationProjection[];
  readonly reason: "OutputWithdrawn";
}

export interface RequiredConsumerRebindPlan {
  readonly planId: string;
  readonly bindingId: string;
  readonly consumerGroupId: string;
  readonly grantRef: string;
  readonly publicationAddress: string;
  readonly targetPublicationAddress: string;
  readonly reason: "breaking-producer-change";
}

export interface ProducerChangeBlockingIssue {
  readonly code:
    | "consumer_rebind_plan_required"
    | "consumer_rebind_target_mismatch"
    | "unknown_consumer_rebind";
  readonly bindingId: string;
  readonly message: string;
}

export interface ProducerChangePlan {
  readonly previousPublicationId: string;
  readonly nextPublicationId: string;
  readonly compatibility: "compatible" | "breaking";
  readonly canProceed: boolean;
  readonly requiredRebinds: readonly RequiredConsumerRebindPlan[];
  readonly providedRebinds: readonly ProducerChangeRebind[];
  readonly dependentPlans: readonly RequiredConsumerRebindPlan[];
  readonly blockingIssues: readonly ProducerChangeBlockingIssue[];
}

export interface PlanDeploymentInput {
  readonly spaceId: string;
  readonly groupId: string;
  readonly bindings?: readonly PublicationConsumerBinding[];
  readonly publications?: readonly Publication[];
}

export interface DeploymentPublicationDependencyPlan {
  readonly spaceId: string;
  readonly groupId: string;
  readonly edges: readonly PublicationDependencyEdge[];
  readonly projections: readonly PublicationProjection[];
}

export interface PublicationDependencyEdge {
  readonly consumerGroupId: string;
  readonly producerGroupId: string;
  readonly publicationAddress: string;
  readonly bindingId: string;
}

export class PublicationDependencyPlanner {
  readonly #stores: PublicationPlannerStores;
  readonly #idFactory: () => string;
  readonly #clock: () => Date;
  readonly #requireCrossGroupGrant: boolean;

  constructor(options: PublicationDependencyPlannerOptions) {
    this.#stores = options.stores;
    this.#idFactory = options.idFactory ?? (() => crypto.randomUUID());
    this.#clock = options.clock ?? (() => new Date());
    this.#requireCrossGroupGrant = options.requireCrossGroupGrant ?? false;
  }

  async validateConsumerBinding(
    input: ValidateConsumerBindingInput,
  ): Promise<ValidatedConsumerBinding> {
    const publication = await this.#resolvePublication(
      input.binding.spaceId,
      input.binding.publicationAddress,
      input.candidatePublications,
    );

    if (publication.producerGroupId === input.binding.consumerGroupId) {
      throw conflict("Publication binding cycle detected", {
        bindingId: input.binding.id,
        consumerGroupId: input.binding.consumerGroupId,
        producerGroupId: publication.producerGroupId,
        publicationAddress: publication.address,
      });
    }

    if (publication.contract !== input.binding.contract) {
      throw conflict("Publication contract does not match binding", {
        bindingId: input.binding.id,
        bindingContract: input.binding.contract,
        publicationContract: publication.contract,
        publicationAddress: input.binding.publicationAddress,
      });
    }

    const grant = await this.#validateGrant(input.binding, publication);
    const outputByName = new Map(
      publication.outputs.map((output) => [output.name, output]),
    );
    const explicitOutputNames: string[] = [];
    const approvalRequiredOutputNames: string[] = [];
    const approvedOutputNames: string[] = [];
    for (const [alias, injection] of Object.entries(input.binding.outputs)) {
      if (injection.explicit !== true) {
        throw invalidArgument("Publication output injection must be explicit", {
          bindingId: input.binding.id,
          alias,
        });
      }
      if (!injection.env && !injection.binding) {
        throw invalidArgument(
          "Publication output injection must name an env or binding target",
          {
            bindingId: input.binding.id,
            alias,
            outputName: injection.outputName,
          },
        );
      }
      const output = outputByName.get(injection.outputName);
      if (!output) {
        throw conflict("Publication output is not provided by producer", {
          bindingId: input.binding.id,
          outputName: injection.outputName,
          publicationAddress: publication.address,
        });
      }
      if (output.valueType !== injection.valueType) {
        throw conflict("Publication output value type does not match binding", {
          bindingId: input.binding.id,
          outputName: injection.outputName,
          bindingValueType: injection.valueType,
          publicationValueType: output.valueType,
        });
      }
      if (requiresInjectionApproval(output)) {
        approvalRequiredOutputNames.push(output.name);
        const approval = findApproval(input.approvals ?? [], {
          bindingId: input.binding.id,
          grantRef: input.binding.grantRef,
          outputName: output.name,
        });
        if (!approval) {
          throw permissionDenied(
            "Publication output injection requires explicit approval",
            {
              bindingId: input.binding.id,
              outputName: output.name,
              valueType: output.valueType,
              sensitive: output.sensitive === true,
              grantRef: input.binding.grantRef,
            },
          );
        }
        approvedOutputNames.push(output.name);
      }
      explicitOutputNames.push(injection.outputName);
    }

    const explicitSet = new Set(explicitOutputNames);
    const missingRequired = publication.outputs
      .filter((output) => output.required && !explicitSet.has(output.name))
      .map((output) => output.name);
    if (missingRequired.length > 0) {
      throw conflict("Required publication outputs must be explicitly bound", {
        bindingId: input.binding.id,
        missingRequiredOutputs: missingRequired,
        publicationAddress: publication.address,
      });
    }

    return Object.freeze({
      binding: input.binding,
      publication,
      grant,
      explicitOutputNames,
      approvalRequiredOutputNames,
      approvedOutputNames,
    });
  }

  async planConsumerBinding(
    input: PlanConsumerBindingInput,
  ): Promise<PlanConsumerBindingResult> {
    const validated = await this.validateConsumerBinding(input);
    const resolvedAt = input.projectedAt ?? this.#now();
    const resolution = await this.#buildResolution({
      binding: validated.binding,
      publication: validated.publication,
      resolvedAt,
    });
    const projection = projectPublicationResolution(resolution, {
      id: input.projectionId ?? this.#idFactory(),
      projectedAt: resolvedAt,
    });
    if (projection.diagnostics.length > 0) {
      throw conflict("Publication projection has diagnostics", {
        bindingId: input.binding.id,
        diagnostics: projection.diagnostics,
      });
    }
    if (input.persist) {
      await this.#stores.bindings.put(validated.binding);
      await this.#stores.resolutions?.put(resolution);
      await this.#stores.projections?.put(projection);
    }
    return Object.freeze({ ...validated, resolution, projection });
  }

  async planProducerChange(
    input: PlanProducerChangeInput,
  ): Promise<ProducerChangePlan> {
    const consumers = await this.#stores.bindings.listByPublicationAddress(
      input.previous.spaceId,
      input.previous.address,
    );
    const requiredRebinds = input.compatibility === "breaking"
      ? consumers.map((binding) => ({
        planId: `publication-rebind:${input.next.id}:${binding.id}`,
        bindingId: binding.id,
        consumerGroupId: binding.consumerGroupId,
        grantRef: binding.grantRef,
        publicationAddress: binding.publicationAddress,
        targetPublicationAddress: input.next.address,
        reason: "breaking-producer-change" as const,
      }))
      : [];
    const providedRebinds = input.consumerRebinds ?? [];
    const requiredByBindingId = new Map(
      requiredRebinds.map((required) => [required.bindingId, required]),
    );
    const providedByBindingId = new Map(
      providedRebinds.map((rebind) => [rebind.bindingId, rebind]),
    );
    const blockingIssues: ProducerChangeBlockingIssue[] = [];
    for (const required of requiredRebinds) {
      const provided = providedByBindingId.get(required.bindingId);
      if (!provided) {
        blockingIssues.push({
          code: "consumer_rebind_plan_required",
          bindingId: required.bindingId,
          message:
            `consumer ${required.consumerGroupId} requires a dependent rebind plan for publication ${required.publicationAddress}`,
        });
        continue;
      }
      if (
        provided.targetPublicationAddress &&
        provided.targetPublicationAddress !== input.next.address
      ) {
        blockingIssues.push({
          code: "consumer_rebind_target_mismatch",
          bindingId: required.bindingId,
          message:
            `consumer rebind ${required.bindingId} targets ${provided.targetPublicationAddress}, expected ${input.next.address}`,
        });
      }
    }
    for (const provided of providedRebinds) {
      if (!requiredByBindingId.has(provided.bindingId)) {
        blockingIssues.push({
          code: "unknown_consumer_rebind",
          bindingId: provided.bindingId,
          message:
            `consumer rebind ${provided.bindingId} does not match an affected consumer binding`,
        });
      }
    }
    const canProceed = blockingIssues.length === 0;
    return Object.freeze({
      previousPublicationId: input.previous.id,
      nextPublicationId: input.next.id,
      compatibility: input.compatibility,
      canProceed,
      requiredRebinds,
      providedRebinds,
      dependentPlans: requiredRebinds,
      blockingIssues,
    });
  }

  async planPublicationWithdrawal(
    input: PlanPublicationWithdrawalInput,
  ): Promise<PublicationWithdrawalPlan> {
    const projectedAt = input.projectedAt ?? this.#now();
    const withdrawnPublication: Publication = Object.freeze({
      ...input.publication,
      withdrawnAt: input.publication.withdrawnAt ??
        input.withdrawnAt ?? projectedAt,
      updatedAt: projectedAt,
    });
    const bindings = await this.#stores.bindings.listByPublicationAddress(
      withdrawnPublication.spaceId,
      withdrawnPublication.address,
    );
    const existingProjections = this.#stores.projections
      ? await this.#stores.projections.listByPublication(
        withdrawnPublication.id,
      )
      : [];
    const existingByBinding = new Map(
      existingProjections.map((
        projection,
      ) => [projection.bindingId, projection]),
    );
    const projections: PublicationProjection[] = [];
    for (const binding of bindings) {
      const existing = existingByBinding.get(binding.id);
      const projection = existing
        ? invalidateProjectionForWithdrawal(existing, {
          publication: withdrawnPublication,
          projectedAt,
        })
        : projectPublication({
          id: `publication-projection:${binding.id}`,
          binding,
          publication: withdrawnPublication,
          projectedAt,
        });
      projections.push(projection);
      if (input.persist) {
        await this.#stores.projections?.put(projection);
      }
    }
    if (input.persist) {
      await this.#stores.publications.put(withdrawnPublication);
    }
    return Object.freeze({
      publicationId: withdrawnPublication.id,
      publicationAddress: withdrawnPublication.address,
      affectedBindingIds: bindings.map((binding) => binding.id),
      projections,
      reason: "OutputWithdrawn" as const,
    });
  }

  async planDeployment(
    input: PlanDeploymentInput,
  ): Promise<DeploymentPublicationDependencyPlan> {
    const candidatePublications = input.publications ?? [];
    const storedBindings = await this.#stores.bindings.listByConsumer(
      input.spaceId,
      input.groupId,
    );
    const bindings = [...storedBindings, ...(input.bindings ?? [])];
    const edges: PublicationDependencyEdge[] = [];
    const projections: PublicationProjection[] = [];
    for (const binding of bindings) {
      const planned = await this.planConsumerBinding({
        binding,
        candidatePublications,
        projectionId: `publication-projection:${binding.id}`,
        persist: this.#stores.projections !== undefined,
      });
      edges.push({
        consumerGroupId: binding.consumerGroupId,
        producerGroupId: planned.publication.producerGroupId,
        publicationAddress: planned.publication.address,
        bindingId: binding.id,
      });
      projections.push(planned.projection);
    }

    const allEdges = await this.#allDependencyEdges(input.spaceId, {
      bindings,
      candidatePublications,
    });
    const cycle = findCycle(allEdges);
    if (cycle) {
      throw conflict("Publication dependency cycle detected", {
        cycle,
      });
    }

    return Object.freeze({
      spaceId: input.spaceId,
      groupId: input.groupId,
      edges,
      projections,
    });
  }

  async #validateGrant(
    binding: PublicationConsumerBinding,
    publication: Publication,
  ): Promise<PublicationGrant | undefined> {
    if (binding.grantRef.trim().length === 0) {
      throw permissionDenied("Publication consumer binding requires a grant", {
        bindingId: binding.id,
        publicationAddress: binding.publicationAddress,
      });
    }
    if (
      this.#requireCrossGroupGrant &&
      binding.consumerGroupId !== publication.producerGroupId &&
      !this.#stores.grants
    ) {
      throw permissionDenied(
        "Cross-group publication binding requires a grant store",
        {
          bindingId: binding.id,
          consumerGroupId: binding.consumerGroupId,
          producerGroupId: publication.producerGroupId,
          publicationAddress: publication.address,
        },
      );
    }
    const grant = await this.#stores.grants?.get(binding.grantRef);
    if (!this.#stores.grants) return undefined;
    if (!grant) {
      throw permissionDenied("Publication grant was not found", {
        bindingId: binding.id,
        grantRef: binding.grantRef,
        publicationAddress: binding.publicationAddress,
      });
    }
    if (grant.status !== "active") {
      throw permissionDenied("Publication grant is not active", {
        bindingId: binding.id,
        grantRef: binding.grantRef,
        status: grant.status,
      });
    }
    if (
      grant.expiresAt &&
      Date.parse(grant.expiresAt) <= this.#clock().getTime()
    ) {
      throw permissionDenied("Publication grant has expired", {
        bindingId: binding.id,
        grantRef: binding.grantRef,
        expiresAt: grant.expiresAt,
      });
    }
    const mismatches: string[] = [];
    if (grant.spaceId !== binding.spaceId) mismatches.push("spaceId");
    if (grant.consumerGroupId !== binding.consumerGroupId) {
      mismatches.push("consumerGroupId");
    }
    if (grant.producerGroupId !== publication.producerGroupId) {
      mismatches.push("producerGroupId");
    }
    if (grant.publicationAddress !== publication.address) {
      mismatches.push("publicationAddress");
    }
    if (grant.contract !== publication.contract) mismatches.push("contract");
    if (mismatches.length > 0) {
      throw permissionDenied("Publication grant does not match binding", {
        bindingId: binding.id,
        grantRef: binding.grantRef,
        mismatches,
      });
    }
    return grant;
  }

  async #buildResolution(input: {
    readonly binding: PublicationConsumerBinding;
    readonly publication: Publication;
    readonly resolvedAt: string;
  }): Promise<CorePublicationResolution> {
    const digest = digestPublicationResolution({
      binding: resolutionBindingSnapshot(input.binding),
      publication: resolutionPublicationSnapshot(input.publication),
    });
    const previous = this.#stores.resolutions
      ? await this.#stores.resolutions.listByBinding(input.binding.id)
      : [];
    const latest =
      previous.toSorted((a, b) => b.resolvedAt.localeCompare(a.resolvedAt))[0];
    return buildPublicationResolution({
      id: `publication-resolution:${input.binding.id}:${digest}`,
      digest,
      binding: input.binding,
      publication: input.publication,
      resolvedAt: input.resolvedAt,
      rebindCandidate: latest !== undefined && latest.digest !== digest,
    });
  }

  async #resolvePublication(
    spaceId: string,
    address: string,
    candidatePublications: readonly Publication[] = [],
  ): Promise<Publication> {
    const candidateMatches = candidatePublications.filter((publication) =>
      publication.spaceId === spaceId
    );
    const storedMatches = await this.#stores.publications.list({
      spaceId,
      includeWithdrawn: true,
    });
    const withdrawnExact = [...candidateMatches, ...storedMatches]
      .filter((publication) =>
        publication.address === address && publication.withdrawnAt
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    if (withdrawnExact) {
      throw conflict("Publication has been withdrawn", {
        spaceId,
        address,
        publicationId: withdrawnExact.id,
        reason: "OutputWithdrawn",
      });
    }
    const candidates = [
      ...candidateMatches.filter((publication) => !publication.withdrawnAt),
      ...storedMatches.filter((publication) => !publication.withdrawnAt),
    ];
    const exact = candidates
      .filter((publication) => publication.address === address)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    if (exact.length > 0) return exact[0];

    if (!isShortPublicationName(address)) {
      throw conflict("Publication address is not bound", {
        spaceId,
        address,
        reason: "OutputUnavailable",
      });
    }

    const shortMatches = candidates.filter((publication) =>
      publication.name === address ||
      lastAddressSegment(publication.address) === address
    );
    if (shortMatches.length === 1) return shortMatches[0];
    if (shortMatches.length > 1) {
      throw conflict("Ambiguous publication short name", {
        spaceId,
        shortName: address,
        matches: shortMatches.map((publication) => publication.address).sort(),
      });
    }
    throw conflict("Publication address is not bound", {
      spaceId,
      address,
      reason: "OutputUnavailable",
    });
  }

  async #allDependencyEdges(
    spaceId: string,
    input: {
      readonly bindings: readonly PublicationConsumerBinding[];
      readonly candidatePublications: readonly Publication[];
    },
  ): Promise<readonly PublicationDependencyEdge[]> {
    const allBindings = new Map<string, PublicationConsumerBinding>();
    for (
      const publication of await this.#stores.publications.list({ spaceId })
    ) {
      const producerBindings = await this.#stores.bindings.listByConsumer(
        spaceId,
        publication.producerGroupId,
      );
      for (const binding of producerBindings) {
        allBindings.set(
          binding.id,
          binding,
        );
      }
    }
    for (const binding of input.bindings) allBindings.set(binding.id, binding);

    const edges: PublicationDependencyEdge[] = [];
    for (const binding of allBindings.values()) {
      const publication = await this.#resolvePublication(
        spaceId,
        binding.publicationAddress,
        input.candidatePublications,
      );
      edges.push({
        consumerGroupId: binding.consumerGroupId,
        producerGroupId: publication.producerGroupId,
        publicationAddress: publication.address,
        bindingId: binding.id,
      });
    }
    return edges;
  }

  #now(): string {
    return this.#clock().toISOString();
  }
}

function invalidateProjectionForWithdrawal(
  projection: PublicationProjection,
  input: {
    readonly publication: Publication;
    readonly projectedAt: string;
  },
): PublicationProjection {
  const diagnostic =
    `publication withdrawn at ${input.publication.withdrawnAt}`;
  return Object.freeze({
    ...projection,
    activationId: input.publication.activationId,
    appReleaseId: input.publication.appReleaseId,
    projectedAt: input.projectedAt,
    status: input.publication.policy.withdrawal === "retain-last-projection"
      ? "degraded" as const
      : "invalidated" as const,
    reason: "OutputWithdrawn" as const,
    withdrawn: true,
    diagnostics: projection.diagnostics.includes(diagnostic)
      ? projection.diagnostics
      : [...projection.diagnostics, diagnostic],
  });
}

function isShortPublicationName(address: string): boolean {
  return !address.includes("/") && !address.includes(":");
}

function lastAddressSegment(address: string): string {
  return address.split(/[/:]/).filter(Boolean).at(-1) ?? address;
}

function requiresInjectionApproval(output: PublicationOutput): boolean {
  return output.sensitive === true || output.valueType === "secret-ref";
}

function resolutionBindingSnapshot(binding: PublicationConsumerBinding) {
  return {
    id: binding.id,
    spaceId: binding.spaceId,
    consumerGroupId: binding.consumerGroupId,
    publicationAddress: binding.publicationAddress,
    contract: binding.contract,
    outputs: binding.outputs,
    grantRef: binding.grantRef,
    rebindPolicy: binding.rebindPolicy,
  };
}

function resolutionPublicationSnapshot(publication: Publication) {
  return {
    id: publication.id,
    spaceId: publication.spaceId,
    producerGroupId: publication.producerGroupId,
    activationId: publication.activationId,
    appReleaseId: publication.appReleaseId,
    address: publication.address,
    contract: publication.contract,
    outputs: publication.outputs,
    withdrawnAt: publication.withdrawnAt,
  };
}

function digestPublicationResolution(value: unknown): string {
  return `sha256:${
    createHash("sha256").update(stableStringify(value)).digest("hex")
  }`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${
    Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${stableStringify(record[key])}`
    ).join(",")
  }}`;
}

function findApproval(
  approvals: readonly PublicationOutputInjectionApproval[],
  expected: {
    readonly bindingId: string;
    readonly grantRef: string;
    readonly outputName: string;
  },
): PublicationOutputInjectionApproval | undefined {
  return approvals.find((approval) =>
    approval.approved === true &&
    approval.bindingId === expected.bindingId &&
    approval.grantRef === expected.grantRef &&
    approval.outputName === expected.outputName
  );
}

function findCycle(
  edges: readonly PublicationDependencyEdge[],
): readonly string[] | undefined {
  const graph = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (!graph.has(edge.consumerGroupId)) {
      graph.set(edge.consumerGroupId, new Set());
    }
    graph.get(edge.consumerGroupId)!.add(edge.producerGroupId);
    if (!graph.has(edge.producerGroupId)) {
      graph.set(edge.producerGroupId, new Set());
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  const visit = (node: string): readonly string[] | undefined => {
    if (visiting.has(node)) {
      const start = stack.indexOf(node);
      return [...stack.slice(start), node];
    }
    if (visited.has(node)) return undefined;
    visiting.add(node);
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    stack.pop();
    visiting.delete(node);
    visited.add(node);
    return undefined;
  };

  for (const node of graph.keys()) {
    const cycle = visit(node);
    if (cycle) return cycle;
  }
  return undefined;
}
