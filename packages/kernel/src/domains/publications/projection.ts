import type {
  CorePublicationResolution,
  Publication,
  PublicationConsumerBinding,
  PublicationProjection,
  PublicationProjectionOutput,
} from "./types.ts";

export interface ProjectPublicationInput {
  readonly id: string;
  readonly binding: PublicationConsumerBinding;
  readonly publication: Publication;
  readonly projectedAt: string;
}

export function projectPublication(
  input: ProjectPublicationInput,
): PublicationProjection {
  return projectPublicationResolution(
    buildPublicationResolution({
      id: `publication-resolution:${input.binding.id}`,
      binding: input.binding,
      publication: input.publication,
      digest: "",
      resolvedAt: input.projectedAt,
      rebindCandidate: false,
    }),
    { id: input.id, projectedAt: input.projectedAt },
  );
}

export interface BuildPublicationResolutionInput {
  readonly id: string;
  readonly digest: string;
  readonly binding: PublicationConsumerBinding;
  readonly publication: Publication;
  readonly resolvedAt: string;
  readonly rebindCandidate: boolean;
}

export function buildPublicationResolution(
  input: BuildPublicationResolutionInput,
): CorePublicationResolution {
  const withdrawn = Boolean(input.publication.withdrawnAt);
  const diagnostics: string[] = withdrawn
    ? [`publication withdrawn at ${input.publication.withdrawnAt}`]
    : [];
  const outputs: PublicationProjectionOutput[] = [];
  if (!withdrawn) {
    for (const [alias, injection] of Object.entries(input.binding.outputs)) {
      const output = input.publication.outputs.find((candidate) =>
        candidate.name === injection.outputName || candidate.name === alias
      );
      if (!output) {
        diagnostics.push(`missing publication output: ${injection.outputName}`);
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
    publicationId: input.publication.id,
    publicationAddress: input.publication.address,
    producerGroupId: input.publication.producerGroupId,
    activationId: input.publication.activationId,
    appReleaseId: input.publication.appReleaseId,
    contract: input.publication.contract,
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

export function projectPublicationResolution(
  resolution: CorePublicationResolution,
  input: {
    readonly id: string;
    readonly projectedAt: string;
  },
): PublicationProjection {
  return {
    id: input.id,
    resolutionId: resolution.id,
    resolutionDigest: resolution.digest,
    spaceId: resolution.spaceId,
    consumerGroupId: resolution.consumerGroupId,
    bindingId: resolution.bindingId,
    publicationId: resolution.publicationId,
    publicationAddress: resolution.publicationAddress,
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
