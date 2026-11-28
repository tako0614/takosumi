import { capsuleScopeRef } from "takosumi-contract/capsules";
import type { Capsule, InstallConfig } from "takosumi-contract/install-configs";
import { stableJsonDigest } from "../../adapters/source/digest.ts";

/** Digest of an immutable successor, excluding the seal stored inside it. */
export function installConfigSuccessorDigest(target: InstallConfig): Promise<string> {
  const receipt = target.internal?.reAdoption;
  if (!receipt) return stableJsonDigest(target);
  const { derivedTargetDigest: _seal, ...receiptWithoutSeal } = receipt;
  return stableJsonDigest({
    ...target,
    internal: { ...target.internal, reAdoption: receiptWithoutSeal },
  });
}

export async function hasValidDerivedTargetSeal(target: InstallConfig): Promise<boolean> {
  const receipt = target.internal?.reAdoption;
  return Boolean(receipt && /^sha256:[0-9a-f]{64}$/u.test(receipt.derivedTargetDigest) &&
    await installConfigSuccessorDigest(target) === receipt.derivedTargetDigest);
}

/** Deterministic successor identity shared by the writer and Plan admission. */
export async function reAdoptionTargetInstallConfigId(input: {
  readonly scopeRef: string;
  readonly capsuleId: string;
  readonly actorSubject: string;
  readonly idempotencyKeyHash: string;
}): Promise<string> {
  const digest = await stableJsonDigest({
    kind: "capsule_install_config_re_adoption_v1",
    workspaceId: input.scopeRef,
    capsuleId: input.capsuleId,
    actorSubject: input.actorSubject,
    idempotencyKeyHash: input.idempotencyKeyHash,
  });
  return `icfg_${digest.replace(/^sha256:/u, "").slice(0, 16)}`;
}

/** Repository settings stay pending until their base StateVersion advances. */
export async function pendingRepositoryReAdoptionReceipt(capsule: Capsule, config: InstallConfig) {
  const receipt = config.internal?.reAdoption;
  if (!receipt || !capsule.currentStateVersionId ||
    config.id !== capsule.installConfigId ||
    receipt.capsuleId !== capsule.id ||
    receipt.previousStateVersionId !== capsule.currentStateVersionId ||
    receipt.previousStateGeneration !== capsule.currentStateGeneration ||
    config.installExperience?.repositoryInstallUx?.status !== "accepted") return undefined;
  const targetId = await reAdoptionTargetInstallConfigId({
    scopeRef: capsuleScopeRef(capsule), capsuleId: capsule.id,
    actorSubject: receipt.actorSubject, idempotencyKeyHash: receipt.idempotencyKeyHash,
  });
  return targetId === config.id ? receipt : undefined;
}
