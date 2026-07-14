import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import {
  platformHardeningEvidenceDocumentErrors,
  TAKOSUMI_PLATFORM_HARDENING_GATE_EVIDENCE_KIND,
  type PlatformHardeningCheckDefinition,
  type PlatformHardeningContribution,
  type PlatformHardeningGateEvidence,
} from "../contract/platform-hardening.ts";
import {
  OSS_PLATFORM_HARDENING_CONTRIBUTION,
  platformHardeningContributions,
} from "../deploy/platform/production_hardening.ts";

export const PRODUCTION_HARDENING_EVIDENCE_KIND =
  "takosumi.platform-hardening-evidence@v1" as const;

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const GIT_REF_PATTERN = /^git\+[^#]+#[^#]+$/;
const GIT_COMMIT_PIN_PATTERN = /@[0-9a-f]{40,64}$/i;

export interface ProductionHardeningEvidenceManifest {
  readonly kind: typeof PRODUCTION_HARDENING_EVIDENCE_KIND;
  readonly generatedAt: string;
  readonly environment: "staging" | "production";
  readonly contributions: readonly ProductionHardeningEvidenceContribution[];
}

export interface ProductionHardeningEvidenceContribution {
  readonly id: string;
  readonly capability: string;
  readonly checks: readonly ProductionHardeningEvidenceCheck[];
}

export interface ProductionHardeningEvidenceCheck {
  readonly id: string;
  readonly evidenceRef: string;
  readonly evidenceDigest: string;
  readonly live: true;
  readonly summary: string;
  readonly document: Readonly<Record<string, unknown>>;
}

export interface ProductionHardeningEvidenceValidation {
  readonly status: "passed";
  readonly manifestDigest: string;
  readonly generatedAt: string;
  readonly environment: ProductionHardeningEvidenceManifest["environment"];
  readonly registry: readonly {
    readonly id: string;
    readonly capability: string;
    readonly checks: readonly string[];
  }[];
  readonly gateEvidence: PlatformHardeningGateEvidence;
  readonly env: {
    readonly TAKOSUMI_PLATFORM_HARDENING_EVIDENCE: string;
  };
}

export interface ProductionHardeningEvidenceOptions {
  readonly contributions?: readonly PlatformHardeningContribution[];
}

export interface ProductionHardeningEvidenceFileOptions extends ProductionHardeningEvidenceOptions {
  readonly evidenceRoot?: string;
}

export function productionHardeningEvidenceTemplate(
  options: ProductionHardeningEvidenceOptions = {},
): ProductionHardeningEvidenceManifest {
  const registry = normalizedRegistry(options.contributions);
  const evidenceRefBase =
    "git+ssh://git@github.com/<operator>/operator-state.git@<40-hex-commit>";
  return {
    kind: PRODUCTION_HARDENING_EVIDENCE_KIND,
    generatedAt: "2026-07-13T00:00:00.000Z",
    environment: "production",
    contributions: registry.map((contribution) => ({
      id: contribution.id,
      capability: contribution.capability,
      checks: contribution.checks.map((check) => ({
        id: check.id,
        evidenceRef: `${evidenceRefBase}#evidence/${contribution.id}/${check.id}.json`,
        evidenceDigest: "sha256:<64-lowercase-hex>",
        live: true,
        summary: `Live operator evidence for ${check.title}.`,
        document: evidenceDocumentTemplate(check),
      })),
    })),
  };
}

export async function validateProductionHardeningEvidenceFile(
  path: string,
  options: ProductionHardeningEvidenceFileOptions = {},
): Promise<ProductionHardeningEvidenceValidation> {
  const raw = await readFile(path, "utf8");
  const registry = normalizedRegistry(options.contributions);
  const manifest = readManifest(JSON.parse(raw) as unknown, registry);
  await verifyEvidenceFileDigests(
    manifest,
    options.evidenceRoot ?? defaultEvidenceRoot(path),
  );
  return buildValidation(manifest, registry, raw);
}

export async function updateProductionHardeningEvidenceDigestsFile(
  path: string,
  options: ProductionHardeningEvidenceFileOptions = {},
): Promise<ProductionHardeningEvidenceValidation> {
  const raw = await readFile(path, "utf8");
  const draft = record(
    JSON.parse(raw) as unknown,
    "production hardening evidence manifest",
  );
  const contributions = array(
    draft.contributions,
    "production hardening evidence contributions",
  );
  const evidenceRoot = options.evidenceRoot ?? defaultEvidenceRoot(path);
  for (const contribution of contributions) {
    const contributionRow = record(contribution, "hardening contribution");
    const checks = array(
      contributionRow.checks,
      "hardening contribution checks",
    );
    for (const check of checks) {
      const row = record(check, "hardening evidence check");
      const id = nonEmpty(row.id, "hardening evidence check id");
      const evidenceRef = nonEmpty(row.evidenceRef, `${id}.evidenceRef`);
      const evidencePath = evidencePathFromGitRef(
        evidenceRef,
        evidenceRoot,
        id,
      );
      row.evidenceDigest = `sha256:${createHash("sha256")
        .update(await readFile(evidencePath))
        .digest("hex")}`;
    }
  }

  const registry = normalizedRegistry(options.contributions);
  const nextRaw = `${JSON.stringify(draft, null, 2)}\n`;
  const manifest = readManifest(draft, registry);
  await verifyEvidenceFileDigests(manifest, evidenceRoot);
  await writeFile(path, nextRaw);
  return buildValidation(manifest, registry, nextRaw);
}

export function validateProductionHardeningEvidence(
  value: unknown,
  rawForDigest?: string,
  options: ProductionHardeningEvidenceOptions = {},
): ProductionHardeningEvidenceValidation {
  const registry = normalizedRegistry(options.contributions);
  const manifest = readManifest(value, registry);
  return buildValidation(manifest, registry, rawForDigest);
}

function normalizedRegistry(
  configured: readonly PlatformHardeningContribution[] | undefined,
): readonly PlatformHardeningContribution[] {
  if (configured === undefined) {
    return [OSS_PLATFORM_HARDENING_CONTRIBUTION];
  }
  const ids = configured.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) {
    throw new TypeError("platform hardening contribution ids must be unique");
  }
  const configuredOss = configured.find(
    ({ id }) => id === OSS_PLATFORM_HARDENING_CONTRIBUTION.id,
  );
  if (
    configuredOss &&
    JSON.stringify(configuredOss) !==
      JSON.stringify(OSS_PLATFORM_HARDENING_CONTRIBUTION)
  ) {
    throw new TypeError(
      "OSS platform hardening contribution cannot be overridden",
    );
  }
  return platformHardeningContributions(
    configured.filter(
      ({ id }) => id !== OSS_PLATFORM_HARDENING_CONTRIBUTION.id,
    ),
  );
}

function buildValidation(
  manifest: ProductionHardeningEvidenceManifest,
  registry: readonly PlatformHardeningContribution[],
  rawForDigest?: string,
): ProductionHardeningEvidenceValidation {
  const gateEvidence: PlatformHardeningGateEvidence = {
    kind: TAKOSUMI_PLATFORM_HARDENING_GATE_EVIDENCE_KIND,
    contributions: manifest.contributions.map((contribution) => ({
      id: contribution.id,
      capability: contribution.capability,
      checks: contribution.checks.map((check) => ({
        id: check.id,
        evidenceRef: check.evidenceRef,
        evidenceDigest: check.evidenceDigest,
      })),
    })),
  };
  const canonical = rawForDigest ?? JSON.stringify(manifest);
  return {
    status: "passed",
    manifestDigest: `sha256:${createHash("sha256")
      .update(canonical)
      .digest("hex")}`,
    generatedAt: manifest.generatedAt,
    environment: manifest.environment,
    registry: registry.map((contribution) => ({
      id: contribution.id,
      capability: contribution.capability,
      checks: contribution.checks.map(({ id }) => id),
    })),
    gateEvidence,
    env: {
      TAKOSUMI_PLATFORM_HARDENING_EVIDENCE: JSON.stringify(gateEvidence),
    },
  };
}

function readManifest(
  value: unknown,
  registry: readonly PlatformHardeningContribution[],
): ProductionHardeningEvidenceManifest {
  const manifest = record(value, "production hardening evidence manifest");
  if (manifest.kind !== PRODUCTION_HARDENING_EVIDENCE_KIND) {
    throw new Error(
      `production hardening evidence kind must be ${PRODUCTION_HARDENING_EVIDENCE_KIND}`,
    );
  }
  if (
    manifest.environment !== "staging" &&
    manifest.environment !== "production"
  ) {
    throw new Error("production hardening evidence environment is invalid");
  }
  if (!validIsoDate(manifest.generatedAt)) {
    throw new Error("production hardening evidence generatedAt is invalid");
  }
  const contributionRows = array(
    manifest.contributions,
    "production hardening evidence contributions",
  );
  const duplicateContribution = duplicate(
    contributionRows.map((item) =>
      nonEmpty(record(item, "contribution").id, "contribution.id"),
    ),
  );
  if (duplicateContribution) {
    throw new Error(
      `production hardening evidence has duplicate contribution ${duplicateContribution}`,
    );
  }
  const knownIds = new Set(registry.map(({ id }) => id));
  for (const item of contributionRows) {
    const id = nonEmpty(record(item, "contribution").id, "contribution.id");
    if (!knownIds.has(id)) {
      throw new Error(
        `production hardening evidence has unknown contribution ${id}`,
      );
    }
  }
  const contributions = registry.map((definition) => {
    const value = contributionRows.find(
      (item) => record(item, "contribution").id === definition.id,
    );
    if (!value) {
      throw new Error(
        `production hardening evidence is missing contribution ${definition.id}`,
      );
    }
    return readContribution(value, definition);
  });
  return {
    kind: PRODUCTION_HARDENING_EVIDENCE_KIND,
    generatedAt: manifest.generatedAt,
    environment: manifest.environment,
    contributions,
  };
}

function readContribution(
  value: unknown,
  definition: PlatformHardeningContribution,
): ProductionHardeningEvidenceContribution {
  const row = record(value, `hardening contribution ${definition.id}`);
  if (row.capability !== definition.capability) {
    throw new Error(
      `hardening contribution ${definition.id} capability drifted`,
    );
  }
  const checkRows = array(
    row.checks,
    `hardening contribution ${definition.id} checks`,
  );
  const ids = checkRows.map((item) =>
    nonEmpty(record(item, "hardening check").id, "hardening check id"),
  );
  const duplicateId = duplicate(ids);
  if (duplicateId) {
    throw new Error(
      `hardening contribution ${definition.id} has duplicate check ${duplicateId}`,
    );
  }
  const knownIds = new Set(definition.checks.map(({ id }) => id));
  for (const id of ids) {
    if (!knownIds.has(id)) {
      throw new Error(
        `hardening contribution ${definition.id} has unknown check ${id}`,
      );
    }
  }
  return {
    id: definition.id,
    capability: definition.capability,
    checks: definition.checks.map((checkDefinition) => {
      const check = checkRows.find(
        (item) => record(item, "hardening check").id === checkDefinition.id,
      );
      if (!check) {
        throw new Error(
          `hardening contribution ${definition.id} is missing check ${checkDefinition.id}`,
        );
      }
      return readCheck(check, definition.id, checkDefinition);
    }),
  };
}

function readCheck(
  value: unknown,
  contributionId: string,
  definition: PlatformHardeningCheckDefinition,
): ProductionHardeningEvidenceCheck {
  const label = `${contributionId}/${definition.id}`;
  const row = record(value, `${label} evidence`);
  if (row.live !== true) throw new Error(`${label}.live must be true`);
  if (!nonEmptyString(row.summary))
    throw new Error(`${label}.summary is required`);
  const evidenceRef = nonEmpty(row.evidenceRef, `${label}.evidenceRef`);
  if (!GIT_REF_PATTERN.test(evidenceRef)) {
    throw new Error(`${label}.evidenceRef must be a git+ ref with #path`);
  }
  const parsedEvidenceRef = parseEvidenceRef(evidenceRef, label);
  if (!GIT_COMMIT_PIN_PATTERN.test(parsedEvidenceRef.gitRef)) {
    throw new Error(
      `${label}.evidenceRef must be pinned to an immutable git commit`,
    );
  }
  if (
    /fixture|todo|example\.com|\.invalid|localhost|127\.0\.0\.1/i.test(
      evidenceRef,
    )
  ) {
    throw new Error(
      `${label}.evidenceRef must be non-fixture operator evidence`,
    );
  }
  const evidenceDigest = nonEmpty(
    row.evidenceDigest,
    `${label}.evidenceDigest`,
  );
  if (!DIGEST_PATTERN.test(evidenceDigest)) {
    throw new Error(`${label}.evidenceDigest must be sha256:<64hex>`);
  }
  const document = record(row.document, `${label}.document`);
  const errors = platformHardeningEvidenceDocumentErrors(
    document,
    definition.evidenceSchema,
    `${label}.document`,
  );
  if (errors.length) throw new Error(errors.join("\n"));
  return {
    id: definition.id,
    evidenceRef,
    evidenceDigest,
    live: true,
    summary: row.summary,
    document,
  };
}

async function verifyEvidenceFileDigests(
  manifest: ProductionHardeningEvidenceManifest,
  evidenceRoot: string,
): Promise<void> {
  for (const contribution of manifest.contributions) {
    for (const check of contribution.checks) {
      const label = `${contribution.id}/${check.id}`;
      const evidencePath = evidencePathFromGitRef(
        check.evidenceRef,
        evidenceRoot,
        label,
      );
      const digest = `sha256:${createHash("sha256")
        .update(await readFile(evidencePath))
        .digest("hex")}`;
      if (digest !== check.evidenceDigest) {
        throw new Error(
          `${label}.evidenceDigest does not match ${evidencePath}`,
        );
      }
    }
  }
}

function evidencePathFromGitRef(
  evidenceRef: string,
  evidenceRoot: string,
  name: string,
): string {
  const { path } = parseEvidenceRef(evidenceRef, name);
  if (!path || path.startsWith("/") || path.split(/[\\/]+/).includes("..")) {
    throw new Error(`${name}.evidenceRef path is unsafe`);
  }
  return resolve(evidenceRoot, path);
}

function evidenceDocumentTemplate(
  definition: PlatformHardeningCheckDefinition,
): Record<string, unknown> {
  const document: Record<string, unknown> = {};
  for (const field of definition.evidenceSchema.required ?? []) {
    const schema = definition.evidenceSchema.properties?.[field];
    if (!schema) {
      document[field] = `<${field}>`;
      continue;
    }
    if (schema.example !== undefined) {
      document[field] = Array.isArray(schema.example)
        ? [...schema.example]
        : schema.example;
    } else if (schema.const !== undefined) {
      document[field] = schema.const;
    } else if (schema.enum?.length) {
      document[field] = schema.enum[0];
    } else if (schema.type === "string") {
      document[field] = `<${field}>`;
    } else if (schema.type === "number") {
      document[field] = Math.max(schema.minimum ?? 1, 1);
    } else if (schema.type === "boolean") {
      document[field] = true;
    } else {
      document[field] = schema.contains?.length
        ? [...schema.contains]
        : [`<${field}>`];
    }
  }
  return document;
}

function defaultEvidenceRoot(path: string): string {
  const dir = dirname(resolve(path));
  return basename(dir) === "evidence" ? dirname(dir) : dir;
}

function parseEvidenceRef(
  evidenceRef: string,
  name: string,
): { readonly gitRef: string; readonly path: string } {
  const parts = evidenceRef.split("#");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`${name}.evidenceRef must be a git+ ref with #path`);
  }
  return { gitRef: parts[0], path: parts[1] };
}

function duplicate(values: readonly string[]): string | undefined {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return undefined;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, name: string): readonly unknown[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${name} must be a non-empty array`);
  }
  return value;
}

function nonEmpty(value: unknown, name: string): string {
  if (!nonEmptyString(value)) throw new Error(`${name} is required`);
  return value;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validIsoDate(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  ) {
    return false;
  }
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

if (import.meta.main) {
  try {
    const args = parseCliArgs(Bun.argv.slice(2));
    const registry = await loadRegistry(args.contributionPaths);
    if (args.printTemplate) {
      console.log(
        JSON.stringify(
          productionHardeningEvidenceTemplate({ contributions: registry }),
          null,
          2,
        ),
      );
      process.exit(0);
    }
    if (!args.path) {
      console.log(
        "Usage: bun scripts/validate-production-hardening-evidence.ts <manifest.json> [--evidence-root path] [--contribution contribution.json]\n       bun scripts/validate-production-hardening-evidence.ts --update-digests <manifest.json> [--evidence-root path] [--contribution contribution.json]\n       bun scripts/validate-production-hardening-evidence.ts --print-template [--contribution contribution.json]",
      );
      process.exit(
        Bun.argv.some((arg) => arg === "--help" || arg === "-h") ? 0 : 1,
      );
    }
    const options = {
      evidenceRoot: args.evidenceRoot,
      contributions: registry,
    };
    const result = args.updateDigests
      ? await updateProductionHardeningEvidenceDigestsFile(args.path, options)
      : await validateProductionHardeningEvidenceFile(args.path, options);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

async function loadRegistry(
  contributionPaths: readonly string[],
): Promise<readonly PlatformHardeningContribution[]> {
  const additional = await Promise.all(
    contributionPaths.map(async (path) =>
      JSON.parse(await readFile(path, "utf8")),
    ),
  );
  return platformHardeningContributions(additional);
}

function parseCliArgs(args: readonly string[]): {
  readonly path?: string;
  readonly evidenceRoot?: string;
  readonly printTemplate: boolean;
  readonly updateDigests: boolean;
  readonly contributionPaths: readonly string[];
} {
  let path: string | undefined;
  let evidenceRoot: string | undefined;
  let printTemplate = false;
  let updateDigests = false;
  const contributionPaths: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      return { printTemplate, updateDigests, contributionPaths };
    }
    if (arg === "--print-template") {
      printTemplate = true;
      continue;
    }
    if (arg === "--update-digests") {
      updateDigests = true;
      continue;
    }
    if (arg === "--evidence-root") {
      evidenceRoot = args[index + 1];
      if (!evidenceRoot) throw new Error("--evidence-root requires a path");
      index += 1;
      continue;
    }
    if (arg === "--contribution") {
      const contributionPath = args[index + 1];
      if (!contributionPath) throw new Error("--contribution requires a path");
      contributionPaths.push(contributionPath);
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) throw new Error(`unknown argument: ${arg}`);
    if (path) throw new Error(`unexpected argument: ${arg}`);
    path = arg;
  }
  return {
    path,
    evidenceRoot,
    printTemplate,
    updateDigests,
    contributionPaths,
  };
}
