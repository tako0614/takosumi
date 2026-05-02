import { createHash } from "node:crypto";
import {
  buildOutputResolution,
  type CoreOutputResolution,
  type CoreOutputResolutionStore,
  type Output,
  type OutputConsumerBinding,
  type OutputConsumerBindingStore,
  type OutputGrant,
  type OutputGrantStore,
  type OutputInjectionApproval,
  type OutputProjection,
  type OutputProjectionStore,
  type OutputStore,
  type OutputValue,
  projectOutput,
  projectOutputResolution,
} from "../../domains/outputs/mod.ts";
import {
  conflict,
  invalidArgument,
  permissionDenied,
} from "../../shared/errors.ts";

export interface OutputPlannerStores {
  readonly outputs: OutputStore;
  readonly bindings: OutputConsumerBindingStore;
  readonly grants?: OutputGrantStore;
  readonly resolutions?: CoreOutputResolutionStore;
  readonly projections?: OutputProjectionStore;
}

export interface OutputDependencyPlannerOptions {
  readonly stores: OutputPlannerStores;
  readonly idFactory?: () => string;
  readonly clock?: () => Date;
  readonly requireCrossGroupGrant?: boolean;
}

export interface ValidateConsumerBindingInput {
  readonly binding: OutputConsumerBinding;
  readonly candidateOutputs?: readonly Output[];
  readonly approvals?: readonly OutputInjectionApproval[];
}

export interface ValidatedConsumerBinding {
  readonly binding: OutputConsumerBinding;
  readonly output: Output;
  readonly grant?: OutputGrant;
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
  readonly resolution: CoreOutputResolution;
  readonly projection: OutputProjection;
}

export interface ProducerChangeRebind {
  readonly bindingId: string;
  readonly targetOutputAddress?: string;
  readonly reason?: string;
}

export interface PlanProducerChangeInput {
  readonly previous: Output;
  readonly next: Output;
  readonly compatibility: "compatible" | "breaking";
  readonly consumerRebinds?: readonly ProducerChangeRebind[];
}

export interface PlanOutputWithdrawalInput {
  readonly output: Output;
  readonly withdrawnAt?: string;
  readonly projectedAt?: string;
  readonly persist?: boolean;
}

export interface OutputWithdrawalPlan {
  readonly outputId: string;
  readonly outputAddress: string;
  readonly affectedBindingIds: readonly string[];
  readonly projections: readonly OutputProjection[];
  readonly reason: "OutputWithdrawn";
}

export interface RequiredConsumerRebindPlan {
  readonly planId: string;
  readonly bindingId: string;
  readonly consumerGroupId: string;
  readonly grantRef: string;
  readonly outputAddress: string;
  readonly targetOutputAddress: string;
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
  readonly previousOutputId: string;
  readonly nextOutputId: string;
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
  readonly bindings?: readonly OutputConsumerBinding[];
  readonly outputs?: readonly Output[];
}

export interface DeploymentOutputDependencyPlan {
  readonly spaceId: string;
  readonly groupId: string;
  readonly edges: readonly OutputDependencyEdge[];
  readonly projections: readonly OutputProjection[];
}

export interface OutputDependencyEdge {
  readonly consumerGroupId: string;
  readonly producerGroupId: string;
  readonly outputAddress: string;
  readonly bindingId: string;
}

export class OutputDependencyPlanner {
  readonly #stores: OutputPlannerStores;
  readonly #idFactory: () => string;
  readonly #clock: () => Date;
  readonly #requireCrossGroupGrant: boolean;

  constructor(options: OutputDependencyPlannerOptions) {
    this.#stores = options.stores;
    this.#idFactory = options.idFactory ?? (() => crypto.randomUUID());
    this.#clock = options.clock ?? (() => new Date());
    this.#requireCrossGroupGrant = options.requireCrossGroupGrant ?? false;
  }

  async validateConsumerBinding(
    input: ValidateConsumerBindingInput,
  ): Promise<ValidatedConsumerBinding> {
    const output = await this.#resolveOutput(
      input.binding.spaceId,
      input.binding.outputAddress,
      input.candidateOutputs,
    );

    if (output.producerGroupId === input.binding.consumerGroupId) {
      throw conflict("Output binding cycle detected", {
        bindingId: input.binding.id,
        consumerGroupId: input.binding.consumerGroupId,
        producerGroupId: output.producerGroupId,
        outputAddress: output.address,
      });
    }

    if (output.contract !== input.binding.contract) {
      throw conflict("Output contract does not match binding", {
        bindingId: input.binding.id,
        bindingContract: input.binding.contract,
        outputContract: output.contract,
        outputAddress: input.binding.outputAddress,
      });
    }

    const grant = await this.#validateGrant(input.binding, output);
    const outputByName = new Map(
      output.outputs.map((value) => [value.name, value]),
    );
    const explicitOutputNames: string[] = [];
    const approvalRequiredOutputNames: string[] = [];
    const approvedOutputNames: string[] = [];
    for (const [alias, injection] of Object.entries(input.binding.outputs)) {
      if (injection.explicit !== true) {
        throw invalidArgument("Output output injection must be explicit", {
          bindingId: input.binding.id,
          alias,
        });
      }
      if (!injection.env && !injection.binding) {
        throw invalidArgument(
          "Output output injection must name an env or binding target",
          {
            bindingId: input.binding.id,
            alias,
            outputName: injection.outputName,
          },
        );
      }
      const value = outputByName.get(injection.outputName);
      if (!value) {
        throw conflict("Output output is not provided by producer", {
          bindingId: input.binding.id,
          outputName: injection.outputName,
          outputAddress: output.address,
        });
      }
      if (value.valueType !== injection.valueType) {
        throw conflict("Output output value type does not match binding", {
          bindingId: input.binding.id,
          outputName: injection.outputName,
          bindingValueType: injection.valueType,
          outputValueType: value.valueType,
        });
      }
      if (requiresInjectionApproval(value)) {
        approvalRequiredOutputNames.push(value.name);
        const approval = findApproval(input.approvals ?? [], {
          bindingId: input.binding.id,
          grantRef: input.binding.grantRef,
          outputName: value.name,
        });
        if (!approval) {
          throw permissionDenied(
            "Output output injection requires explicit approval",
            {
              bindingId: input.binding.id,
              outputName: value.name,
              valueType: value.valueType,
              sensitive: value.sensitive === true,
              grantRef: input.binding.grantRef,
            },
          );
        }
        approvedOutputNames.push(value.name);
      }
      explicitOutputNames.push(injection.outputName);
    }

    const explicitSet = new Set(explicitOutputNames);
    const missingRequired = output.outputs
      .filter((value) => value.required && !explicitSet.has(value.name))
      .map((value) => value.name);
    if (missingRequired.length > 0) {
      throw conflict("Required output outputs must be explicitly bound", {
        bindingId: input.binding.id,
        missingRequiredOutputs: missingRequired,
        outputAddress: output.address,
      });
    }

    return Object.freeze({
      binding: input.binding,
      output,
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
      output: validated.output,
      resolvedAt,
    });
    const projection = projectOutputResolution(resolution, {
      id: input.projectionId ?? this.#idFactory(),
      projectedAt: resolvedAt,
    });
    if (projection.diagnostics.length > 0) {
      throw conflict("Output projection has diagnostics", {
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
    const consumers = await this.#stores.bindings.listByOutputAddress(
      input.previous.spaceId,
      input.previous.address,
    );
    const requiredRebinds = input.compatibility === "breaking"
      ? consumers.map((binding) => ({
        planId: `output-rebind:${input.next.id}:${binding.id}`,
        bindingId: binding.id,
        consumerGroupId: binding.consumerGroupId,
        grantRef: binding.grantRef,
        outputAddress: binding.outputAddress,
        targetOutputAddress: input.next.address,
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
            `consumer ${required.consumerGroupId} requires a dependent rebind plan for output ${required.outputAddress}`,
        });
        continue;
      }
      if (
        provided.targetOutputAddress &&
        provided.targetOutputAddress !== input.next.address
      ) {
        blockingIssues.push({
          code: "consumer_rebind_target_mismatch",
          bindingId: required.bindingId,
          message:
            `consumer rebind ${required.bindingId} targets ${provided.targetOutputAddress}, expected ${input.next.address}`,
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
      previousOutputId: input.previous.id,
      nextOutputId: input.next.id,
      compatibility: input.compatibility,
      canProceed,
      requiredRebinds,
      providedRebinds,
      dependentPlans: requiredRebinds,
      blockingIssues,
    });
  }

  async planOutputWithdrawal(
    input: PlanOutputWithdrawalInput,
  ): Promise<OutputWithdrawalPlan> {
    const projectedAt = input.projectedAt ?? this.#now();
    const withdrawnOutput: Output = Object.freeze({
      ...input.output,
      withdrawnAt: input.output.withdrawnAt ??
        input.withdrawnAt ?? projectedAt,
      updatedAt: projectedAt,
    });
    const bindings = await this.#stores.bindings.listByOutputAddress(
      withdrawnOutput.spaceId,
      withdrawnOutput.address,
    );
    const existingProjections = this.#stores.projections
      ? await this.#stores.projections.listByOutput(
        withdrawnOutput.id,
      )
      : [];
    const existingByBinding = new Map(
      existingProjections.map((
        projection,
      ) => [projection.bindingId, projection]),
    );
    const projections: OutputProjection[] = [];
    for (const binding of bindings) {
      const existing = existingByBinding.get(binding.id);
      const projection = existing
        ? invalidateProjectionForWithdrawal(existing, {
          output: withdrawnOutput,
          projectedAt,
        })
        : projectOutput({
          id: `output-projection:${binding.id}`,
          binding,
          output: withdrawnOutput,
          projectedAt,
        });
      projections.push(projection);
      if (input.persist) {
        await this.#stores.projections?.put(projection);
      }
    }
    if (input.persist) {
      await this.#stores.outputs.put(withdrawnOutput);
    }
    return Object.freeze({
      outputId: withdrawnOutput.id,
      outputAddress: withdrawnOutput.address,
      affectedBindingIds: bindings.map((binding) => binding.id),
      projections,
      reason: "OutputWithdrawn" as const,
    });
  }

  async planDeployment(
    input: PlanDeploymentInput,
  ): Promise<DeploymentOutputDependencyPlan> {
    const candidateOutputs = input.outputs ?? [];
    const storedBindings = await this.#stores.bindings.listByConsumer(
      input.spaceId,
      input.groupId,
    );
    const bindings = [...storedBindings, ...(input.bindings ?? [])];
    const edges: OutputDependencyEdge[] = [];
    const projections: OutputProjection[] = [];
    for (const binding of bindings) {
      const planned = await this.planConsumerBinding({
        binding,
        candidateOutputs,
        projectionId: `output-projection:${binding.id}`,
        persist: this.#stores.projections !== undefined,
      });
      edges.push({
        consumerGroupId: binding.consumerGroupId,
        producerGroupId: planned.output.producerGroupId,
        outputAddress: planned.output.address,
        bindingId: binding.id,
      });
      projections.push(planned.projection);
    }

    const allEdges = await this.#allDependencyEdges(input.spaceId, {
      bindings,
      candidateOutputs,
    });
    const cycle = findCycle(allEdges);
    if (cycle) {
      throw conflict("Output dependency cycle detected", {
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
    binding: OutputConsumerBinding,
    output: Output,
  ): Promise<OutputGrant | undefined> {
    if (binding.grantRef.trim().length === 0) {
      throw permissionDenied("Output consumer binding requires a grant", {
        bindingId: binding.id,
        outputAddress: binding.outputAddress,
      });
    }
    if (
      this.#requireCrossGroupGrant &&
      binding.consumerGroupId !== output.producerGroupId &&
      !this.#stores.grants
    ) {
      throw permissionDenied(
        "Cross-group output binding requires a grant store",
        {
          bindingId: binding.id,
          consumerGroupId: binding.consumerGroupId,
          producerGroupId: output.producerGroupId,
          outputAddress: output.address,
        },
      );
    }
    const grant = await this.#stores.grants?.get(binding.grantRef);
    if (!this.#stores.grants) return undefined;
    if (!grant) {
      throw permissionDenied("Output grant was not found", {
        bindingId: binding.id,
        grantRef: binding.grantRef,
        outputAddress: binding.outputAddress,
      });
    }
    if (grant.status !== "active") {
      throw permissionDenied("Output grant is not active", {
        bindingId: binding.id,
        grantRef: binding.grantRef,
        status: grant.status,
      });
    }
    if (
      grant.expiresAt &&
      Date.parse(grant.expiresAt) <= this.#clock().getTime()
    ) {
      throw permissionDenied("Output grant has expired", {
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
    if (grant.producerGroupId !== output.producerGroupId) {
      mismatches.push("producerGroupId");
    }
    if (grant.outputAddress !== output.address) {
      mismatches.push("outputAddress");
    }
    if (grant.contract !== output.contract) mismatches.push("contract");
    if (mismatches.length > 0) {
      throw permissionDenied("Output grant does not match binding", {
        bindingId: binding.id,
        grantRef: binding.grantRef,
        mismatches,
      });
    }
    return grant;
  }

  async #buildResolution(input: {
    readonly binding: OutputConsumerBinding;
    readonly output: Output;
    readonly resolvedAt: string;
  }): Promise<CoreOutputResolution> {
    const digest = digestOutputResolution({
      binding: resolutionBindingSnapshot(input.binding),
      output: resolutionOutputSnapshot(input.output),
    });
    const previous = this.#stores.resolutions
      ? await this.#stores.resolutions.listByBinding(input.binding.id)
      : [];
    const latest =
      previous.toSorted((a, b) => b.resolvedAt.localeCompare(a.resolvedAt))[0];
    return buildOutputResolution({
      id: `output-resolution:${input.binding.id}:${digest}`,
      digest,
      binding: input.binding,
      output: input.output,
      resolvedAt: input.resolvedAt,
      rebindCandidate: latest !== undefined && latest.digest !== digest,
    });
  }

  async #resolveOutput(
    spaceId: string,
    address: string,
    candidateOutputs: readonly Output[] = [],
  ): Promise<Output> {
    const candidateMatches = candidateOutputs.filter((output) =>
      output.spaceId === spaceId
    );
    const storedMatches = await this.#stores.outputs.list({
      spaceId,
      includeWithdrawn: true,
    });
    const withdrawnExact = [...candidateMatches, ...storedMatches]
      .filter((output) => output.address === address && output.withdrawnAt)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    if (withdrawnExact) {
      throw conflict("Output has been withdrawn", {
        spaceId,
        address,
        outputId: withdrawnExact.id,
        reason: "OutputWithdrawn",
      });
    }
    const candidates = [
      ...candidateMatches.filter((output) => !output.withdrawnAt),
      ...storedMatches.filter((output) => !output.withdrawnAt),
    ];
    const exact = candidates
      .filter((output) => output.address === address)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    if (exact.length > 0) return exact[0];

    if (!isShortOutputName(address)) {
      throw conflict("Output address is not bound", {
        spaceId,
        address,
        reason: "OutputUnavailable",
      });
    }

    const shortMatches = candidates.filter((output) =>
      output.name === address ||
      lastAddressSegment(output.address) === address
    );
    if (shortMatches.length === 1) return shortMatches[0];
    if (shortMatches.length > 1) {
      throw conflict("Ambiguous output short name", {
        spaceId,
        shortName: address,
        matches: shortMatches.map((output) => output.address).sort(),
      });
    }
    throw conflict("Output address is not bound", {
      spaceId,
      address,
      reason: "OutputUnavailable",
    });
  }

  async #allDependencyEdges(
    spaceId: string,
    input: {
      readonly bindings: readonly OutputConsumerBinding[];
      readonly candidateOutputs: readonly Output[];
    },
  ): Promise<readonly OutputDependencyEdge[]> {
    const allBindings = new Map<string, OutputConsumerBinding>();
    for (
      const output of await this.#stores.outputs.list({ spaceId })
    ) {
      const producerBindings = await this.#stores.bindings.listByConsumer(
        spaceId,
        output.producerGroupId,
      );
      for (const binding of producerBindings) {
        allBindings.set(
          binding.id,
          binding,
        );
      }
    }
    for (const binding of input.bindings) allBindings.set(binding.id, binding);

    const edges: OutputDependencyEdge[] = [];
    for (const binding of allBindings.values()) {
      const output = await this.#resolveOutput(
        spaceId,
        binding.outputAddress,
        input.candidateOutputs,
      );
      edges.push({
        consumerGroupId: binding.consumerGroupId,
        producerGroupId: output.producerGroupId,
        outputAddress: output.address,
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
  projection: OutputProjection,
  input: {
    readonly output: Output;
    readonly projectedAt: string;
  },
): OutputProjection {
  const diagnostic = `output withdrawn at ${input.output.withdrawnAt}`;
  return Object.freeze({
    ...projection,
    activationId: input.output.activationId,
    appReleaseId: input.output.appReleaseId,
    projectedAt: input.projectedAt,
    status: input.output.policy.withdrawal === "retain-last-projection"
      ? "degraded" as const
      : "invalidated" as const,
    reason: "OutputWithdrawn" as const,
    withdrawn: true,
    diagnostics: projection.diagnostics.includes(diagnostic)
      ? projection.diagnostics
      : [...projection.diagnostics, diagnostic],
  });
}

function isShortOutputName(address: string): boolean {
  return !address.includes("/") && !address.includes(":");
}

function lastAddressSegment(address: string): string {
  return address.split(/[/:]/).filter(Boolean).at(-1) ?? address;
}

function requiresInjectionApproval(output: OutputValue): boolean {
  return output.sensitive === true || output.valueType === "secret-ref";
}

function resolutionBindingSnapshot(binding: OutputConsumerBinding) {
  return {
    id: binding.id,
    spaceId: binding.spaceId,
    consumerGroupId: binding.consumerGroupId,
    outputAddress: binding.outputAddress,
    contract: binding.contract,
    outputs: binding.outputs,
    grantRef: binding.grantRef,
    rebindPolicy: binding.rebindPolicy,
  };
}

function resolutionOutputSnapshot(output: Output) {
  return {
    id: output.id,
    spaceId: output.spaceId,
    producerGroupId: output.producerGroupId,
    activationId: output.activationId,
    appReleaseId: output.appReleaseId,
    address: output.address,
    contract: output.contract,
    outputs: output.outputs,
    withdrawnAt: output.withdrawnAt,
  };
}

function digestOutputResolution(value: unknown): string {
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
  approvals: readonly OutputInjectionApproval[],
  expected: {
    readonly bindingId: string;
    readonly grantRef: string;
    readonly outputName: string;
  },
): OutputInjectionApproval | undefined {
  return approvals.find((approval) =>
    approval.approved === true &&
    approval.bindingId === expected.bindingId &&
    approval.grantRef === expected.grantRef &&
    approval.outputName === expected.outputName
  );
}

function findCycle(
  edges: readonly OutputDependencyEdge[],
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
