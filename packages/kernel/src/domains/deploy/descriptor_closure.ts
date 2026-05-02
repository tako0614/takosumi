// Descriptor closure construction for Deployment.resolution.
//
// Phase 10A (Wave 1): builds the immutable descriptor closure that pins every
// descriptor referenced (directly or transitively) by a resolved Deployment.
// The closure is the canonical record consumed by Apply — apply MUST reuse the
// closure pinned at resolve time and MUST NOT re-fetch descriptor URLs at
// execution time (Core contract § 6).
//
// What we pin in the closure:
//   1. Authoring-expansion descriptor (`authoring.public-manifest-expansion@v1`)
//      whenever the manifest used a sugar form that the compiler expanded into
//      a canonical `runtime.*` / `resource.*` / `interface.*` / `publication.*`
//      contract instance shape. (Core spec § 5.)
//   2. Runtime contract descriptors for every component (`runtime.js-worker@v1`,
//      `runtime.oci-container@v1`, etc.) plus the `artifact.oci-image@v1`
//      descriptor when the component pulls from a registry image.
//   3. Resource contract descriptors for every declared resource.
//   4. Interface contract descriptors for every route protocol.
//   5. Publication contract descriptors for every publications entry.
//   6. The shared JSON-LD context (`https://takos.dev/contexts/deploy.jsonld`)
//      that all of the above use, recorded as a `jsonld-context` dependency.
//
// Each `CoreDescriptorResolution` carries:
//   - `id`        — canonical URI (e.g. `https://takos.dev/contracts/runtime/oci-container/v1`)
//   - `alias`     — short-form ref (e.g. `runtime.oci-container@v1`)
//   - `mediaType` — `application/ld+json`
//   - `rawDigest` — sha256 over the raw JSON-LD document bytes (canonicalized)
//   - `expandedDigest` — sha256 over the descriptor body augmented with closure
//                       metadata (closure-relative canonical form)
//   - `contextDigests` — referenced JSON-LD context digests
//   - `canonicalization` — algorithm + version actually used
//   - `resolvedAt`     — Deployment resolution timestamp
//
// Implementation notes:
//   - The reference resolver (`OFFICIAL_DESCRIPTOR_CONFORMANCE_RECORDS` in
//     `core_plan.ts`) seeds the URI ↔ alias ↔ raw-digest mapping at startup by
//     reading the in-tree JSON-LD descriptor documents. The closure builder
//     consumes that record set and never re-fetches remote URLs.
//   - Aliases not present in the official set (e.g. provider plugins shipped
//     out-of-tree, future composite descriptors) fall back to a synthetic
//     resolution whose digest is derived from the alias itself; this preserves
//     determinism without claiming bit-exact knowledge of the descriptor body.
//   - The closure digest is a sha256 over the sorted resolutions and
//     dependencies so two manifests that resolve to the same descriptors
//     produce the same digest.

import { createHash } from "node:crypto";
import type {
  CoreDescriptorDependency,
  CoreDescriptorResolution,
  DeploymentDescriptorClosure,
  IsoTimestamp,
} from "takosumi-contract";
import {
  OFFICIAL_DESCRIPTOR_CONFORMANCE_RECORDS,
  type OfficialDescriptorConformanceRecord,
} from "./core_plan.ts";
import type { AppSpec, AppSpecRoute } from "./types.ts";

/** Canonical JSON-LD context URI shared by every official descriptor. */
const TAKOS_CONTEXT_ID = "https://takos.dev/contexts/deploy.jsonld";

/** MIME type used by every JSON-LD descriptor in the official set. */
const DESCRIPTOR_MEDIA_TYPE = "application/ld+json";

/** Canonicalization algorithm + version stamped onto each resolution. */
const CANONICALIZATION = {
  algorithm: "json-stable-stringify",
  version: "takos-paas-v1",
} as const;

/** Authoring-expansion descriptor (always pinned when expansion fired). */
const PUBLIC_MANIFEST_EXPANSION_ALIAS =
  "authoring.public-manifest-expansion@v1";

/** Built-in alias → canonical URI mapping for descriptors that may be
 *  referenced by the manifest but are not present in the in-tree document
 *  registry (e.g. provider plugins shipped via `@takosumi/plugins`). */
const ALIAS_FALLBACK_URI: Record<string, string> = {
  // Providers — shipped by plugins; URIs follow the official-descriptor-set v1
  // naming. We accept either short alias or canonical URI from manifest input.
};

interface DescriptorRefSeed {
  /** Canonical URI or short alias. Both are normalised to URI on lookup. */
  readonly ref: string;
  /** Why this descriptor entered the closure (used for dependency edges). */
  readonly reason?: CoreDescriptorDependency["reason"];
  /** When set, declares this descriptor as a dependency of the named ref. */
  readonly dependencyOf?: string;
}

export interface BuildDescriptorClosureInput {
  readonly appSpec: AppSpec;
  readonly resolvedAt: IsoTimestamp;
  /** Optional extra descriptor refs (e.g. composite expansion children). */
  readonly extraDescriptorRefs?: readonly DescriptorRefSeed[];
}

/** Reference resolver record indexed by both alias and canonical URI. */
interface RegistryEntry {
  readonly id: string;
  readonly alias: string;
  readonly rawDigest: string;
  readonly body: Readonly<Record<string, unknown>> | undefined;
  readonly contextIds: readonly string[];
}

const REGISTRY_BY_ALIAS = new Map<string, RegistryEntry>();
const REGISTRY_BY_URI = new Map<string, RegistryEntry>();

function ensureRegistryLoaded(): void {
  if (REGISTRY_BY_ALIAS.size > 0) return;
  for (const record of OFFICIAL_DESCRIPTOR_CONFORMANCE_RECORDS) {
    const entry: RegistryEntry = {
      id: record.id,
      alias: record.alias,
      rawDigest: record.digest,
      body: record.body as Readonly<Record<string, unknown>>,
      contextIds: contextIdsOf(record),
    };
    REGISTRY_BY_ALIAS.set(record.alias, entry);
    REGISTRY_BY_URI.set(record.id, entry);
  }
  // Synthesise a registry entry for the shared JSON-LD context so it can be
  // emitted as a `jsonld-context` dependency without bespoke handling.
  if (!REGISTRY_BY_URI.has(TAKOS_CONTEXT_ID)) {
    const contextRecord = OFFICIAL_DESCRIPTOR_CONFORMANCE_RECORDS.find(
      (record) => record.id === TAKOS_CONTEXT_ID,
    );
    if (contextRecord) {
      const entry: RegistryEntry = {
        id: contextRecord.id,
        alias: contextRecord.alias,
        rawDigest: contextRecord.digest,
        body: contextRecord.body as Readonly<Record<string, unknown>>,
        contextIds: [],
      };
      REGISTRY_BY_ALIAS.set(contextRecord.alias, entry);
      REGISTRY_BY_URI.set(contextRecord.id, entry);
    }
  }
}

function contextIdsOf(
  record: OfficialDescriptorConformanceRecord,
): readonly string[] {
  const body = record.body as Record<string, unknown>;
  const value = body["@context"];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  return [];
}

/** Resolve an alias-or-URI to a canonical registry entry, or undefined when
 *  the descriptor is not part of the official set (e.g. plugin descriptor). */
function resolveRef(ref: string): RegistryEntry | undefined {
  ensureRegistryLoaded();
  return REGISTRY_BY_ALIAS.get(ref) ?? REGISTRY_BY_URI.get(ref);
}

/** Canonical URI for an alias-or-URI. Falls back to a synthetic descriptor
 *  URI under `https://takos.dev/descriptors/unknown/<sanitised-alias>` when no
 *  registry entry matches; the alias is preserved on the resolution so callers
 *  can inspect the original short form. */
function canonicalUriFor(ref: string): { id: string; alias: string } {
  const entry = resolveRef(ref);
  if (entry) return { id: entry.id, alias: entry.alias };
  if (ALIAS_FALLBACK_URI[ref]) {
    return { id: ALIAS_FALLBACK_URI[ref], alias: ref };
  }
  if (/^https?:\/\//.test(ref)) return { id: ref, alias: ref };
  // Synthesise a stable URI for descriptors we cannot positively identify so
  // every entry on the closure has a canonical URI. The alias is retained for
  // observability and policy gates.
  const sanitised = ref.replace(/[^A-Za-z0-9.@_-]/g, "-").toLowerCase();
  return {
    id: `https://takos.dev/descriptors/unknown/${sanitised}`,
    alias: ref,
  };
}

/** Build a `DeploymentDescriptorClosure` from the resolved AppSpec.
 *
 * The closure is deterministic: identical AppSpecs (with identical authoring
 * expansion outcomes) produce byte-identical closures, byte-identical digests,
 * and byte-identical resolutions. Apply consumes the closure verbatim.
 */
export function buildDescriptorClosure(
  input: BuildDescriptorClosureInput,
): DeploymentDescriptorClosure {
  const seeds = collectSeeds(input.appSpec, input.extraDescriptorRefs ?? []);
  const resolutions: CoreDescriptorResolution[] = [];
  const dependencies: CoreDescriptorDependency[] = [];
  const seenUris = new Set<string>();

  for (const seed of seeds) {
    const { id, alias } = canonicalUriFor(seed.ref);
    if (seenUris.has(id)) continue;
    seenUris.add(id);
    resolutions.push(buildResolution({
      id,
      alias,
      ref: seed.ref,
      resolvedAt: input.resolvedAt,
    }));
  }

  // Add the shared JSON-LD context as a transitive dependency from every
  // descriptor body that referenced it (Core spec § 6 — JSON-LD context is a
  // descriptor dependency, not a free-floating import).
  const contextEntry = resolveRef(TAKOS_CONTEXT_ID);
  if (contextEntry && !seenUris.has(contextEntry.id)) {
    seenUris.add(contextEntry.id);
    resolutions.push(buildResolution({
      id: contextEntry.id,
      alias: contextEntry.alias,
      ref: contextEntry.alias,
      resolvedAt: input.resolvedAt,
    }));
  }
  for (const resolution of resolutions) {
    if (resolution.id === TAKOS_CONTEXT_ID) continue;
    const entry = REGISTRY_BY_URI.get(resolution.id);
    if (!entry) continue;
    if (entry.contextIds.includes(TAKOS_CONTEXT_ID)) {
      dependencies.push({
        fromDescriptorId: resolution.id,
        toDescriptorId: TAKOS_CONTEXT_ID,
        reason: "jsonld-context",
      });
    }
  }

  // Authoring expansion → emitted resolution edges. Spec § 5: expansion
  // descriptor digest MUST be in the closure. We additionally record one
  // `shape-derivation` dependency per expanded descriptor so the closure is
  // self-describing.
  const expansionAliases = authoringExpansionDescriptors(input.appSpec);
  if (expansionAliases.length > 0) {
    const expansionEntry = resolveRef(PUBLIC_MANIFEST_EXPANSION_ALIAS);
    const expansionUri = expansionEntry?.id ?? PUBLIC_MANIFEST_EXPANSION_ALIAS;
    for (const resolution of resolutions) {
      if (resolution.id === expansionUri) continue;
      if (resolution.id === TAKOS_CONTEXT_ID) continue;
      dependencies.push({
        fromDescriptorId: expansionUri,
        toDescriptorId: resolution.id,
        reason: "shape-derivation",
      });
    }
  }

  resolutions.sort((left, right) => left.id.localeCompare(right.id));
  dependencies.sort((left, right) => {
    const cmp = left.fromDescriptorId.localeCompare(right.fromDescriptorId);
    return cmp !== 0
      ? cmp
      : left.toDescriptorId.localeCompare(right.toDescriptorId);
  });

  // C2 — Effective runtime capabilities (post composite + profile merge) are
  // folded into the closure digest so a profile switch that injects different
  // capabilities produces a different digest even when the raw manifest text
  // is identical. The map is built deterministically by the compiler so the
  // resulting digest is stable.
  const effectiveCapabilities = effectiveRuntimeCapabilitiesOf(input.appSpec);
  const closureDigest = digestOf({
    resolutions,
    dependencies,
    effectiveRuntimeCapabilities: effectiveCapabilities,
  });

  return {
    resolutions,
    dependencies: dependencies.length > 0 ? dependencies : undefined,
    closureDigest,
    createdAt: input.resolvedAt,
  };
}

function buildResolution(input: {
  readonly id: string;
  readonly alias: string;
  readonly ref: string;
  readonly resolvedAt: IsoTimestamp;
}): CoreDescriptorResolution {
  const entry = REGISTRY_BY_URI.get(input.id) ??
    REGISTRY_BY_ALIAS.get(input.ref);
  const rawDigest = entry?.rawDigest ?? syntheticDigest(input.id, input.alias);
  const expandedDigest = digestOf({
    id: input.id,
    alias: input.alias,
    rawDigest,
    canonicalization: CANONICALIZATION,
    body: entry?.body ?? null,
  });
  const contextDigests = (entry?.contextIds ?? [])
    .map((contextId) => REGISTRY_BY_URI.get(contextId)?.rawDigest)
    .filter((digest): digest is string => typeof digest === "string");
  return {
    id: input.id,
    alias: input.alias === input.id ? undefined : input.alias,
    documentUrl: input.id,
    mediaType: DESCRIPTOR_MEDIA_TYPE,
    rawDigest,
    expandedDigest,
    contextDigests: contextDigests.length > 0 ? contextDigests : undefined,
    canonicalization: { ...CANONICALIZATION },
    resolvedAt: input.resolvedAt,
  };
}

function collectSeeds(
  appSpec: AppSpec,
  extra: readonly DescriptorRefSeed[],
): readonly DescriptorRefSeed[] {
  const seeds: DescriptorRefSeed[] = [];
  // Authoring expansion descriptor: when the compiler expanded a sugar form
  // we MUST pin its digest (spec § 5).
  for (const alias of authoringExpansionDescriptors(appSpec)) {
    seeds.push({ ref: alias });
  }
  // Component runtimes + image artifacts.
  for (const component of appSpec.components) {
    seeds.push({ ref: component.type });
    if (component.image) {
      seeds.push({ ref: "artifact.oci-image@v1" });
    }
  }
  // Declared resources.
  for (const resource of appSpec.resources) {
    seeds.push({ ref: resource.type });
  }
  // Interface contracts inferred from routes.
  for (const route of appSpec.routes) {
    seeds.push({ ref: routeInterfaceRef(route) });
  }
  // Publication contracts.
  for (const publication of appSpec.publications) {
    seeds.push({ ref: publication.type });
  }
  // Caller-provided extras (e.g. composite descriptor children, provider
  // selections decided upstream of the closure builder).
  for (const seed of extra) seeds.push(seed);
  return seeds;
}

function authoringExpansionDescriptors(appSpec: AppSpec): readonly string[] {
  const maybe = (appSpec as AppSpec & {
    authoringExpansionDescriptors?: readonly string[];
  }).authoringExpansionDescriptors;
  return Array.isArray(maybe) ? maybe : [];
}

/**
 * C2 — Read the post-composite-expansion / post-profile-merge effective
 * runtime capability set off the AppSpec. Returned in canonical sort order
 * so the digest input is stable regardless of insertion order.
 */
function effectiveRuntimeCapabilitiesOf(
  appSpec: AppSpec,
): Record<string, readonly string[]> {
  const maybe = appSpec.effectiveRuntimeCapabilities;
  if (!maybe) return {};
  const out: Record<string, readonly string[]> = {};
  for (const name of Object.keys(maybe).sort()) {
    const values = maybe[name];
    if (!values || values.length === 0) continue;
    out[name] = [...values].sort();
  }
  return out;
}

function routeInterfaceRef(route: AppSpecRoute): string {
  const explicit = (route as AppSpecRoute & { interfaceContractRef?: string })
    .interfaceContractRef;
  if (explicit) return explicit;
  // Fall back to inferring from the protocol (the compiler always sets
  // `interfaceContractRef`, but the type is structurally optional).
  const protocol = (route.protocol ?? "https").toLowerCase();
  if (protocol === "http" || protocol === "https") return "interface.http@v1";
  if (protocol === "tcp") return "interface.tcp@v1";
  if (protocol === "udp") return "interface.udp@v1";
  if (protocol === "queue") return "interface.queue@v1";
  if (protocol === "schedule") return "interface.schedule@v1";
  if (protocol === "event") return "interface.event@v1";
  return "interface.http@v1";
}

function digestOf(value: unknown): string {
  return `sha256:${
    createHash("sha256").update(stableStringify(value)).digest("hex")
  }`;
}

function syntheticDigest(id: string, alias: string): string {
  return digestOf({ id, alias, synthetic: true });
}

function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${
      Object.keys(object).sort().map((key) =>
        `${JSON.stringify(key)}:${stableStringify(object[key])}`
      ).join(",")
    }}`;
  }
  return JSON.stringify(value);
}

// Re-export so callers (deployment_service, future composite-resolver) can
// reuse the resolution helper without duplicating canonicalisation.
export { canonicalUriFor as canonicaliseDescriptorRef };

/**
 * Phase 18.2 / H9 — descriptor closure version compatibility verification.
 *
 * The retained closure on `Deployment.resolution.descriptor_closure` is the
 * authoritative pinned record of every descriptor (alias + raw digest +
 * apiVersion) the deployment was resolved against. Apply re-uses that closure
 * verbatim and never re-fetches descriptor URLs (Core contract § 6).
 *
 * Risk: between resolve and apply, an operator might upgrade a provider
 * plugin from `provider.aws.rds@v1` to `provider.aws.rds@v2`. The closure
 * still pins the v1 alias and v1 raw digest, but the live plugin now consumes
 * a v2 descriptor. If apply silently uses the v1-pinned digest against a v2
 * plugin, the deployment ends up with the wrong artifact pinned and may
 * exhibit subtle behavioural drift.
 *
 * The verification function below compares the closure's pinned descriptors
 * against the descriptors the live plugin claims to consume. It rejects two
 * conditions:
 *
 *   1. Major version mismatch — the closure pins `@v1` but the live plugin
 *      consumes `@v2` (or vice versa). Major version bumps signal a breaking
 *      contract change; we MUST fail-closed and require the user to redeploy
 *      so a fresh closure is built.
 *   2. Raw digest mismatch on the same major version — the closure pins a
 *      digest the live plugin no longer claims to know about. This catches
 *      `apiVersion` field changes that don't bump the alias version.
 */
export interface LiveDescriptorState {
  /**
   * Canonical alias the live plugin currently consumes (e.g.
   * `provider.aws.rds@v2`).
   */
  readonly alias: string;
  /**
   * Raw digest of the descriptor the live plugin is bound to. The closure's
   * `rawDigest` for the same alias must match.
   */
  readonly rawDigest: string;
  /**
   * Optional `apiVersion` field surfaced from the descriptor body. Used by
   * the major-version compatibility check when the alias does not encode the
   * version.
   */
  readonly apiVersion?: string;
}

export type ClosureVersionMismatchKind =
  | "major-version-mismatch"
  | "digest-mismatch"
  | "alias-not-loaded";

export interface ClosureVersionMismatch {
  readonly alias: string;
  readonly kind: ClosureVersionMismatchKind;
  /** Closure-pinned alias (always `alias`). */
  readonly pinnedAlias: string;
  /** Closure-pinned raw digest. */
  readonly pinnedDigest: string;
  /** Live plugin alias when known. */
  readonly liveAlias?: string;
  /** Live plugin raw digest when known. */
  readonly liveDigest?: string;
  /** Human-readable migration guide. */
  readonly migrationGuide: string;
}

export interface ClosureVersionCompatibilityReport {
  readonly compatible: boolean;
  readonly mismatches: readonly ClosureVersionMismatch[];
}

/**
 * Verify that every descriptor pinned in `closure` is still compatible with
 * the live plugin set described by `liveDescriptors` (alias → live state).
 *
 * Apply MUST call this BEFORE consuming the closure. When `compatible` is
 * false, apply MUST fail-closed with the rendered migration guide rather
 * than proceeding with stale pins.
 *
 * Aliases the live plugin set does not know about are reported as
 * `alias-not-loaded` — typical when an operator disables a plugin between
 * resolve and apply. The closure still pins the alias; we cannot proceed
 * without the plugin so we fail-closed and ask the user to either re-enable
 * the plugin or rebuild the closure.
 */
export function verifyClosureVersionCompatibility(
  closure: DeploymentDescriptorClosure,
  liveDescriptors: ReadonlyMap<string, LiveDescriptorState>,
): ClosureVersionCompatibilityReport {
  const mismatches: ClosureVersionMismatch[] = [];
  for (const resolution of closure.resolutions) {
    const alias = resolution.alias ?? resolution.id;
    // Only verify provider / runtime / resource / publication / interface
    // descriptors the live plugin set is expected to know about. The shared
    // JSON-LD context, authoring expansion descriptors, and synthetic
    // unknown descriptors are not provider-supplied and thus not checked.
    if (!isPluginOwnedDescriptorAlias(alias)) continue;
    const live = liveDescriptors.get(alias);
    if (!live) {
      // Try lookup by canonical id as a fallback.
      const liveByUri = liveDescriptors.get(resolution.id);
      if (!liveByUri) {
        mismatches.push({
          alias,
          kind: "alias-not-loaded",
          pinnedAlias: alias,
          pinnedDigest: resolution.rawDigest,
          migrationGuide:
            `Descriptor '${alias}' is pinned in the deployment closure but ` +
            `no loaded provider plugin currently consumes it. Either re-enable ` +
            `the plugin that supplies '${alias}', or redeploy the manifest so a ` +
            `fresh closure is built against the currently loaded plugin set.`,
        });
        continue;
      }
      verifyAliasMatch(resolution, alias, liveByUri, mismatches);
      continue;
    }
    verifyAliasMatch(resolution, alias, live, mismatches);
  }
  return {
    compatible: mismatches.length === 0,
    mismatches,
  };
}

function verifyAliasMatch(
  resolution: CoreDescriptorResolution,
  alias: string,
  live: LiveDescriptorState,
  mismatches: ClosureVersionMismatch[],
): void {
  const pinnedMajor = parseMajorVersion(alias);
  const liveMajor = parseMajorVersion(live.alias);
  if (
    pinnedMajor !== undefined && liveMajor !== undefined &&
    pinnedMajor !== liveMajor
  ) {
    mismatches.push({
      alias,
      kind: "major-version-mismatch",
      pinnedAlias: alias,
      pinnedDigest: resolution.rawDigest,
      liveAlias: live.alias,
      liveDigest: live.rawDigest,
      migrationGuide:
        `Descriptor '${alias}' was pinned at major version v${pinnedMajor} ` +
        `but the live plugin now consumes '${live.alias}' (major v${liveMajor}). ` +
        `Major version bumps signal a breaking contract change and the closure ` +
        `cannot be safely reused. Run \`takos deploy plan --refresh\` against ` +
        `the manifest to rebuild the descriptor closure against v${liveMajor}, ` +
        `then re-apply.`,
    });
    return;
  }
  if (resolution.rawDigest !== live.rawDigest) {
    mismatches.push({
      alias,
      kind: "digest-mismatch",
      pinnedAlias: alias,
      pinnedDigest: resolution.rawDigest,
      liveAlias: live.alias,
      liveDigest: live.rawDigest,
      migrationGuide:
        `Descriptor '${alias}' raw digest pinned in the closure ` +
        `(${resolution.rawDigest}) does not match the digest the loaded plugin ` +
        `currently consumes (${live.rawDigest}). The descriptor body changed ` +
        `(likely an apiVersion bump that did not change the alias). Rebuild ` +
        `the descriptor closure with \`takos deploy plan --refresh\` and re-apply.`,
    });
  }
}

/**
 * Parse the trailing `@v<N>` major-version segment of a canonical alias.
 * Returns undefined for aliases that do not encode a version (e.g.
 * `https://...` URIs, the JSON-LD context, synthetic unknown descriptors).
 */
function parseMajorVersion(alias: string): number | undefined {
  const match = /@v(\d+)(?:\.|$)/.exec(alias);
  if (!match) return undefined;
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Phase 18.2 / H9 — convenience wrapper that throws a descriptive Error when
 * the closure is incompatible with the live registry. This is the shape the
 * apply orchestrator actually wants: it can hand the function (curried with
 * the live registry) to `applyDeployment` as its `descriptorClosureValidator`
 * and get fail-closed behaviour automatically.
 *
 * Returns silently when compatible; throws a `TypeError` whose message lists
 * every mismatch with its migration guide when not.
 */
export function verifyDescriptorClosureCompatibility(
  closure: DeploymentDescriptorClosure,
  liveDescriptors: ReadonlyMap<string, LiveDescriptorState>,
): void {
  const report = verifyClosureVersionCompatibility(closure, liveDescriptors);
  if (report.compatible) return;
  const lines = report.mismatches.map((entry) => {
    const liveSuffix = entry.liveAlias
      ? ` (live alias '${entry.liveAlias}', live digest ${
        entry.liveDigest ?? "<unknown>"
      })`
      : "";
    return `  - [${entry.kind}] ${entry.alias}${liveSuffix}: ${entry.migrationGuide}`;
  });
  throw new TypeError(
    `descriptor closure incompatible with live registry: ${report.mismatches.length} mismatch(es)\n${
      lines.join("\n")
    }`,
  );
}

/**
 * Heuristic: only descriptor aliases the provider plugin layer is expected
 * to consume should be verified. Authoring-expansion descriptors and the
 * shared JSON-LD context are kernel-owned, not plugin-owned.
 */
function isPluginOwnedDescriptorAlias(alias: string): boolean {
  if (alias === TAKOS_CONTEXT_ID) return false;
  if (alias.startsWith("authoring.")) return false;
  if (alias.startsWith("https://takos.dev/contexts/")) return false;
  if (alias.startsWith("https://takos.dev/descriptors/unknown/")) return false;
  // runtime / resource / interface / publication / provider aliases are
  // plugin-owned. URIs that resolve to a registry entry are also covered.
  return /^(runtime|resource|interface|publication|provider|artifact)\./
    .test(alias) || /^https?:\/\//.test(alias);
}
