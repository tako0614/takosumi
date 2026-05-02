import type {
  CoreOutputResolution,
  Output,
  OutputConsumerBinding,
  OutputProjection,
  OutputProjectionOutput,
} from "./types.ts";

export interface ProjectOutputInput {
  readonly id: string;
  readonly binding: OutputConsumerBinding;
  readonly output: Output;
  readonly projectedAt: string;
}

export function projectOutput(
  input: ProjectOutputInput,
): OutputProjection {
  return projectOutputResolution(
    buildOutputResolution({
      id: `output-resolution:${input.binding.id}`,
      binding: input.binding,
      output: input.output,
      digest: "",
      resolvedAt: input.projectedAt,
      rebindCandidate: false,
    }),
    { id: input.id, projectedAt: input.projectedAt },
  );
}

export interface BuildOutputResolutionInput {
  readonly id: string;
  readonly digest: string;
  readonly binding: OutputConsumerBinding;
  readonly output: Output;
  readonly resolvedAt: string;
  readonly rebindCandidate: boolean;
}

export function buildOutputResolution(
  input: BuildOutputResolutionInput,
): CoreOutputResolution {
  const withdrawn = Boolean(input.output.withdrawnAt);
  const diagnostics: string[] = withdrawn
    ? [`output withdrawn at ${input.output.withdrawnAt}`]
    : [];
  const outputs: OutputProjectionOutput[] = [];
  if (!withdrawn) {
    for (const [alias, injection] of Object.entries(input.binding.outputs)) {
      const output = input.output.outputs.find((candidate) =>
        candidate.name === injection.outputName || candidate.name === alias
      );
      if (!output) {
        diagnostics.push(`missing output output: ${injection.outputName}`);
        continue;
      }
      outputs.push({
        name: output.name,
        valueType: output.valueType,
        value: output.value,
        injectedAs: { env: injection.env, binding: injection.binding },
      });
    }
  }
  return {
    id: input.id,
    digest: input.digest,
    spaceId: input.binding.spaceId,
    consumerGroupId: input.binding.consumerGroupId,
    bindingId: input.binding.id,
    outputId: input.output.id,
    outputAddress: input.output.address,
    producerGroupId: input.output.producerGroupId,
    activationId: input.output.activationId,
    appReleaseId: input.output.appReleaseId,
    contract: input.output.contract,
    outputs,
    resolvedAt: input.resolvedAt,
    status: withdrawn
      ? "invalidated"
      : diagnostics.length > 0
      ? "degraded"
      : "ready",
    reason: withdrawn
      ? "OutputWithdrawn"
      : diagnostics.length > 0
      ? "OutputUnavailable"
      : undefined,
    withdrawn,
    diagnostics,
    rebindCandidate: input.rebindCandidate,
  };
}

export function projectOutputResolution(
  resolution: CoreOutputResolution,
  input: {
    readonly id: string;
    readonly projectedAt: string;
  },
): OutputProjection {
  return {
    id: input.id,
    resolutionId: resolution.id,
    resolutionDigest: resolution.digest,
    spaceId: resolution.spaceId,
    consumerGroupId: resolution.consumerGroupId,
    bindingId: resolution.bindingId,
    outputId: resolution.outputId,
    outputAddress: resolution.outputAddress,
    producerGroupId: resolution.producerGroupId,
    activationId: resolution.activationId,
    appReleaseId: resolution.appReleaseId,
    contract: resolution.contract,
    outputs: resolution.outputs,
    projectedAt: input.projectedAt,
    status: resolution.status,
    reason: resolution.reason,
    withdrawn: resolution.withdrawn,
    diagnostics: resolution.diagnostics,
  };
}
