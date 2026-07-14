// Resource Shape Resolver — PURE, deterministic, and provider-neutral.
//
// Every executable candidate comes from a TargetPool implementation descriptor.
// Core never derives an implementation, provider, module, native resource type,
// or capability matrix from a Target type, Resource kind, or vendor name. The
// selected Target + complete descriptor are frozen in ResolutionLock; migration
// remains an explicit operation.

import type {
  CapabilityLevel,
  InterfaceCapabilityScore,
  NativeResourceRef,
  ResolutionLock,
  ResolverInput,
  ResolverOutput,
  ResourceObject,
  ResourcePortability,
  SpacePolicy,
  TargetImplementationDescriptor,
  TargetPoolEntry,
} from "takosumi-contract";

/** Result of {@link resolve}: a typed success/failure outcome (no throws). */
export type ResolveOutcome =
  | { readonly ok: true; readonly output: ResolverOutput }
  | {
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string };
    };

function fail(code: string, message: string): ResolveOutcome {
  return { ok: false, error: { code, message } };
}

function resourceName(resource: ResourceObject): string {
  const specName = (resource.spec as { readonly name?: unknown }).name;
  if (typeof specName === "string" && specName.length > 0) return specName;
  return resource.metadata.name;
}

function resourceId(resource: ResourceObject): string {
  return `tkrn:${resource.metadata.space}:${resource.kind}:${resource.metadata.name}`;
}

function levelOf(
  descriptor: TargetImplementationDescriptor,
  iface: string,
): CapabilityLevel {
  return descriptor.interfaces[iface] ?? "unsupported";
}

function byName(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const object = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(object)
    .sort(byName)
    .filter((key) => object[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

function cloneDescriptor(
  descriptor: TargetImplementationDescriptor,
): TargetImplementationDescriptor {
  return JSON.parse(
    JSON.stringify(descriptor),
  ) as TargetImplementationDescriptor;
}

function snapshotTarget(
  entry: TargetPoolEntry,
  descriptor: TargetImplementationDescriptor,
): TargetPoolEntry {
  return {
    name: entry.name,
    type: entry.type,
    ...(entry.ref === undefined ? {} : { ref: entry.ref }),
    ...(entry.credentialRef === undefined
      ? {}
      : { credentialRef: entry.credentialRef }),
    ...(entry.region === undefined ? {} : { region: entry.region }),
    priority: entry.priority,
    implementations: [cloneDescriptor(descriptor)],
  };
}

function nativeResourcesFor(
  descriptor: TargetImplementationDescriptor,
  name: string,
): readonly NativeResourceRef[] {
  return descriptor.nativeResourceType
    ? [{ type: descriptor.nativeResourceType, id: name, ownership: "planned" }]
    : [];
}

function computePortability(
  scores: readonly InterfaceCapabilityScore[],
): ResourcePortability {
  const levels = scores.map((score) => score.level);
  if (levels.every((level) => level === "native")) return "portable";
  if (levels.some((level) => level === "emulated" || level === "unsupported")) {
    return "partial";
  }
  if (levels.some((level) => level === "shim")) return "mostly_portable";
  return "portable";
}

function capabilityScoresFor(
  descriptor: TargetImplementationDescriptor,
  interfaces: readonly string[],
): readonly InterfaceCapabilityScore[] {
  return interfaces.map((iface) => ({
    interface: iface,
    level: levelOf(descriptor, iface),
  }));
}

function riskNotesFor(
  implementation: string,
  scores: readonly InterfaceCapabilityScore[],
): string[] {
  const notes: string[] = [];
  for (const score of scores) {
    if (score.level === "shim") {
      notes.push(
        `${score.interface} is provided via an adapter shim on ${implementation}`,
      );
    } else if (score.level === "emulated") {
      notes.push(
        `${score.interface} is emulated by Takosumi on ${implementation}`,
      );
    } else if (score.level === "unsupported") {
      notes.push(`${score.interface} is unsupported on ${implementation}`);
    }
  }
  return notes;
}

interface Selection {
  readonly entry: TargetPoolEntry;
  readonly descriptor: TargetImplementationDescriptor;
}

function implementationFingerprint(
  shape: string,
  selection: Selection,
): string {
  return `resolution-v2:${canonicalJson({
    shape,
    target: snapshotTarget(selection.entry, selection.descriptor),
    implementation: selection.descriptor,
  })}`;
}

function capabilityRank(
  descriptor: TargetImplementationDescriptor,
  interfaces: readonly string[],
): number {
  const weights: Readonly<Record<CapabilityLevel, number>> = {
    native: 3,
    shim: 2,
    emulated: 1,
    unsupported: 0,
  };
  return interfaces.reduce(
    (sum, iface) => sum + weights[levelOf(descriptor, iface)],
    0,
  );
}

type SelectResult =
  | { readonly ok: true; readonly selection: Selection }
  | {
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string };
    };

/** Apply SpacePolicy, filter explicit descriptor evidence, then rank. */
function selectTarget(
  input: ResolverInput,
  requestedInterfaces: readonly string[],
): SelectResult {
  const policy: SpacePolicy["spec"] | undefined = input.spacePolicy?.spec;
  const denied = policy?.deniedTargets;
  const allowed = policy?.allowedTargets;

  const eligible: Selection[] = [];
  let policyEligibleTargets = 0;
  for (const entry of input.targetPool.spec.targets) {
    if (
      denied &&
      (denied.includes(entry.type) || denied.includes(entry.name))
    ) {
      continue;
    }
    if (
      allowed &&
      allowed.length > 0 &&
      !(allowed.includes(entry.type) || allowed.includes(entry.name))
    ) {
      continue;
    }
    policyEligibleTargets += 1;
    for (const descriptor of entry.implementations ?? []) {
      if (descriptor.shape !== input.resource.kind) continue;
      if (
        requestedInterfaces.every(
          (iface) => levelOf(descriptor, iface) !== "unsupported",
        )
      ) {
        eligible.push({ entry, descriptor });
      }
    }
  }

  if (eligible.length === 0) {
    if (policyEligibleTargets === 0) {
      return {
        ok: false,
        error: {
          code: "policy_denied",
          message: `SpacePolicy excludes every Target in the pool for ${input.resource.kind}`,
        },
      };
    }
    return {
      ok: false,
      error: {
        code: "capability_missing",
        message:
          `no policy-eligible Target declares an implementation descriptor ` +
          `for ${input.resource.kind} with the requested interfaces`,
      },
    };
  }

  const ranked = [...eligible].sort(
    (a, b) =>
      b.entry.priority - a.entry.priority ||
      capabilityRank(b.descriptor, requestedInterfaces) -
        capabilityRank(a.descriptor, requestedInterfaces) ||
      byName(a.entry.name, b.entry.name) ||
      byName(a.descriptor.implementation, b.descriptor.implementation),
  );
  return { ok: true, selection: ranked[0]! };
}

function buildFreshOutput(
  input: ResolverInput,
  selection: Selection,
): ResolverOutput {
  const descriptor = cloneDescriptor(selection.descriptor);
  const capabilityScores = capabilityScoresFor(descriptor, input.interfaces);
  const portability = computePortability(capabilityScores);
  const nativeResourcePlan = nativeResourcesFor(
    descriptor,
    resourceName(input.resource),
  );
  const riskNotes = riskNotesFor(descriptor.implementation, capabilityScores);
  const targetSnapshot = snapshotTarget(selection.entry, descriptor);
  const reason = [
    `${descriptor.implementation} selected for ${input.resource.kind} on target ${selection.entry.name} (priority ${selection.entry.priority})`,
    ...capabilityScores.map((score) => `${score.interface} ${score.level}`),
  ];
  const resolutionLock: ResolutionLock = {
    resourceId: resourceId(input.resource),
    selectedImplementation: descriptor.implementation,
    targetPool: input.targetPool.metadata.name,
    target: selection.entry.name,
    targetSnapshot,
    implementationSnapshot: descriptor,
    implementationFingerprint: implementationFingerprint(
      input.resource.kind,
      selection,
    ),
    locked: true,
    reason,
    portability,
    nativeResources: nativeResourcePlan,
  };

  return {
    selectedImplementation: descriptor.implementation,
    selectedImplementationDescriptor: descriptor,
    selectedTarget: selection.entry.name,
    nativeResourcePlan,
    capabilityScores,
    portability,
    riskNotes,
    resolutionLock,
  };
}

function descriptorFromLock(
  input: ResolverInput,
  lock: ResolutionLock,
): TargetImplementationDescriptor | undefined {
  if (lock.implementationSnapshot) {
    return cloneDescriptor(lock.implementationSnapshot);
  }
  const snapshotted = lock.targetSnapshot?.implementations?.find(
    (descriptor) =>
      descriptor.shape === input.resource.kind &&
      descriptor.implementation === lock.selectedImplementation,
  );
  if (snapshotted) return cloneDescriptor(snapshotted);

  // Historical normalization only: an older lock can recover an explicitly
  // declared descriptor from the same named Target. No type/vendor inference.
  const currentTarget = input.targetPool.spec.targets.find(
    (entry) => entry.name === lock.target,
  );
  const current = currentTarget?.implementations?.find(
    (descriptor) =>
      descriptor.shape === input.resource.kind &&
      descriptor.implementation === lock.selectedImplementation,
  );
  return current ? cloneDescriptor(current) : undefined;
}

function targetFromLock(
  input: ResolverInput,
  lock: ResolutionLock,
  descriptor: TargetImplementationDescriptor,
): TargetPoolEntry | undefined {
  if (lock.targetSnapshot) {
    return snapshotTarget(lock.targetSnapshot, descriptor);
  }
  const current = input.targetPool.spec.targets.find(
    (entry) => entry.name === lock.target,
  );
  return current ? snapshotTarget(current, descriptor) : undefined;
}

function buildLockedOutput(
  input: ResolverInput,
  lock: ResolutionLock,
  descriptor: TargetImplementationDescriptor,
  target: TargetPoolEntry,
  freshSelection: SelectResult,
): ResolverOutput {
  const capabilityScores = capabilityScoresFor(descriptor, input.interfaces);
  const portability = lock.portability ?? computePortability(capabilityScores);
  const nativeResourcePlan =
    lock.nativeResources ??
    nativeResourcesFor(descriptor, resourceName(input.resource));
  const riskNotes = riskNotesFor(lock.selectedImplementation, capabilityScores);
  if (
    freshSelection.ok &&
    (freshSelection.selection.entry.name !== lock.target ||
      freshSelection.selection.descriptor.implementation !==
        lock.selectedImplementation)
  ) {
    riskNotes.push(
      `resolution is locked to ${lock.selectedImplementation} on target ${lock.target}; the current request would prefer ${freshSelection.selection.descriptor.implementation} on ${freshSelection.selection.entry.name}, but migration is an explicit operation`,
    );
  }

  const normalizedLock: ResolutionLock = {
    ...lock,
    targetSnapshot: target,
    implementationSnapshot: descriptor,
    implementationFingerprint:
      lock.implementationFingerprint ??
      implementationFingerprint(input.resource.kind, {
        entry: target,
        descriptor,
      }),
    locked: true,
  };
  return {
    selectedImplementation: lock.selectedImplementation,
    selectedImplementationDescriptor: descriptor,
    selectedTarget: lock.target,
    nativeResourcePlan,
    capabilityScores,
    portability,
    riskNotes,
    resolutionLock: normalizedLock,
  };
}

/** Resolve a Resource through explicit TargetPool descriptors only. */
export function resolve(input: ResolverInput): ResolveOutcome {
  const freshSelection = selectTarget(input, input.interfaces);
  const lock = input.existingLock;
  if (lock) {
    const descriptor = descriptorFromLock(input, lock);
    if (!descriptor) {
      return fail(
        "resolution_descriptor_missing",
        `locked implementation ${lock.selectedImplementation} on target ${lock.target} has no recoverable descriptor snapshot`,
      );
    }
    const target = targetFromLock(input, lock, descriptor);
    if (!target) {
      return fail(
        "selected_target_missing",
        `locked target ${lock.target} has no recoverable Target snapshot`,
      );
    }
    return {
      ok: true,
      output: buildLockedOutput(
        input,
        lock,
        descriptor,
        target,
        freshSelection,
      ),
    };
  }

  if (!freshSelection.ok) {
    return { ok: false, error: freshSelection.error };
  }
  return {
    ok: true,
    output: buildFreshOutput(input, freshSelection.selection),
  };
}
