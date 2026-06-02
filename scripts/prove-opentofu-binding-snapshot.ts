#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { dirname, isAbsolute, resolve } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type {
  BindingSelection,
  DeploymentOutputs,
  PlatformService,
  Source,
} from "takosumi-contract/installer-api";
import {
  createOpenTofuPlatformServiceResolver,
  parseOpenTofuOutputs,
  type OpenTofuPlatformServiceDefinition,
} from "../packages/platform-services/src/opentofu-output-resolver.ts";
import { InstallerPipeline } from "../src/service/domains/installer/mod.ts";

const DEFAULT_INPUT =
  "fixtures/opentofu-binding-snapshot-proof/proof-input.json";
const PROOF_KIND = "takosumi.opentofu-binding-snapshot-proof@v1";
const INPUT_KIND = "takosumi.opentofu-binding-snapshot-proof-input@v1";
const ACCEPTED_LIVE_REF_PREFIXES = [
  "artifact://",
  "vault://",
  "s3://",
  "gs://",
  "r2://",
  "secret-manager://",
] as const;

export interface OpenTofuBindingSnapshotProofInput {
  readonly kind: typeof INPUT_KIND;
  readonly live?: boolean;
  readonly spaceId: string;
  readonly source: Source;
  readonly profile?: string;
  readonly bindings: readonly BindingSelection[];
  readonly services: readonly OpenTofuPlatformServiceDefinition[];
  readonly includeSensitiveOutputs?: boolean;
  readonly outputs: {
    readonly file: string;
    readonly ref: string;
  };
  readonly operator: {
    readonly opentofuApplyRef: string;
  };
}

export interface OpenTofuBindingSnapshotProof {
  readonly kind: typeof PROOF_KIND;
  readonly status: "passed";
  readonly generatedAt: string;
  readonly live: boolean;
  readonly operator: {
    readonly opentofuApplyRef: string;
    readonly outputsRef: string;
  };
  readonly evidence: {
    readonly inputDigest: string;
    readonly outputsDigest: string;
    readonly planSnapshotDigest: string;
    readonly dryRunBindingsDigest: string;
    readonly deploymentBindingsDigest: string;
  };
  readonly source: {
    readonly kind: Source["kind"];
    readonly url?: string;
    readonly ref?: string;
    readonly commit?: string;
    readonly sourceDigest?: string;
  };
  readonly installation: {
    readonly id: string;
    readonly status: string;
    readonly currentDeploymentId: string | null;
  };
  readonly deployment: {
    readonly id: string;
    readonly status: string;
    readonly bindingsSnapshot: readonly unknown[];
    readonly outputs: DeploymentOutputs;
  };
  readonly checks: readonly {
    readonly name: string;
    readonly status: "passed";
    readonly message: string;
  }[];
}

export interface RunOpenTofuBindingSnapshotProofOptions {
  readonly inputPath?: string;
  readonly outputPath?: string;
  readonly now?: () => string;
}

export async function runOpenTofuBindingSnapshotProof(
  options: RunOpenTofuBindingSnapshotProofOptions = {},
): Promise<OpenTofuBindingSnapshotProof> {
  const inputPath = resolve(options.inputPath ?? DEFAULT_INPUT);
  const baseDir = dirname(inputPath);
  const inputBytes = await readFile(inputPath);
  const input = parseProofInput(JSON.parse(inputBytes.toString("utf8")));
  validateEvidenceRefs(input);

  const outputsPath = resolveRelative(baseDir, input.outputs.file);
  const outputBytes = await readFile(outputsPath);
  const parsedOutputs = parseOpenTofuOutputs(outputBytes.toString("utf8"));
  const resolver = createOpenTofuPlatformServiceResolver({
    outputs: parsedOutputs,
    services: input.services,
    includeSensitiveOutputs: input.includeSensitiveOutputs === true,
  });
  const source = normalizeSource(input.source, baseDir);

  const pipeline = new InstallerPipeline({
    platformServices: {
      resolve(context): readonly PlatformService[] | undefined {
        return resolver.resolve({
          spaceId: context.spaceId,
          binding: context.binding,
        });
      },
    },
  });
  const dryRun = await pipeline.installationDryRun({
    spaceId: input.spaceId,
    source,
    profile: input.profile,
    bindings: input.bindings,
  });
  const applied = await pipeline.installationApply({
    spaceId: input.spaceId,
    source,
    profile: input.profile,
    bindings: input.bindings,
    expected: dryRun.expected,
  });

  const dryRunBindingsDigest = digestJson(dryRun.installPlan.resolvedBindings);
  const deploymentBindingsDigest = digestJson(
    applied.deployment.bindingsSnapshot,
  );
  if (dryRunBindingsDigest !== deploymentBindingsDigest) {
    throw new Error(
      "deployment bindingsSnapshot does not match reviewed dry-run bindings",
    );
  }

  const proof: OpenTofuBindingSnapshotProof = {
    kind: PROOF_KIND,
    status: "passed",
    generatedAt: options.now?.() ?? new Date().toISOString(),
    live: input.live === true,
    operator: {
      opentofuApplyRef: input.operator.opentofuApplyRef,
      outputsRef: input.outputs.ref,
    },
    evidence: {
      inputDigest: digestBytes(inputBytes),
      outputsDigest: digestBytes(outputBytes),
      planSnapshotDigest: dryRun.planSnapshotDigest,
      dryRunBindingsDigest,
      deploymentBindingsDigest,
    },
    source: {
      kind: applied.deployment.source.kind,
      url: applied.deployment.source.url,
      ref: applied.deployment.source.ref,
      commit: applied.deployment.source.commit,
      sourceDigest: applied.deployment.source.sourceDigest,
    },
    installation: {
      id: applied.installation.id,
      status: applied.installation.status,
      currentDeploymentId: applied.installation.currentDeploymentId ?? null,
    },
    deployment: {
      id: applied.deployment.id,
      status: applied.deployment.status,
      bindingsSnapshot: applied.deployment.bindingsSnapshot,
      outputs: applied.deployment.outputs,
    },
    checks: [
      {
        name: "opentofu-output-import",
        status: "passed",
        message:
          "operator-supplied tofu output -json was parsed without running OpenTofu inside Takosumi",
      },
      {
        name: "platform-service-inventory",
        status: "passed",
        message:
          "OpenTofu outputs materialized operator PlatformService inventory entries",
      },
      {
        name: "deployment-binding-snapshot",
        status: "passed",
        message:
          "Deployment bindingsSnapshot matches the reviewed dry-run binding digest",
      },
    ],
  };

  if (options.outputPath) {
    const outputPath = resolve(options.outputPath);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(proof, null, 2)}\n`);
  }
  return proof;
}

function parseProofInput(value: unknown): OpenTofuBindingSnapshotProofInput {
  const input = record(value, "proof input");
  if (input.kind !== INPUT_KIND) {
    throw new Error(`proof input kind must be ${INPUT_KIND}`);
  }
  requireNonEmptyString(input.spaceId, "spaceId");
  const source = record(input.source, "source") as unknown as Source;
  requireNonEmptyString(source.kind, "source.kind");
  requireNonEmptyString(source.url, "source.url");
  const outputs = record(input.outputs, "outputs");
  requireNonEmptyString(outputs.file, "outputs.file");
  requireNonEmptyString(outputs.ref, "outputs.ref");
  const operator = record(input.operator, "operator");
  requireNonEmptyString(operator.opentofuApplyRef, "operator.opentofuApplyRef");
  if (!Array.isArray(input.bindings) || input.bindings.length === 0) {
    throw new Error("bindings must be a non-empty array");
  }
  if (!Array.isArray(input.services) || input.services.length === 0) {
    throw new Error("services must be a non-empty array");
  }
  return {
    kind: INPUT_KIND,
    live: input.live === true,
    spaceId: input.spaceId,
    source,
    profile: typeof input.profile === "string" ? input.profile : undefined,
    bindings: input.bindings as BindingSelection[],
    services: input.services as OpenTofuPlatformServiceDefinition[],
    includeSensitiveOutputs: input.includeSensitiveOutputs === true,
    outputs: {
      file: outputs.file,
      ref: outputs.ref,
    },
    operator: {
      opentofuApplyRef: operator.opentofuApplyRef,
    },
  };
}

function validateEvidenceRefs(input: OpenTofuBindingSnapshotProofInput): void {
  if (input.live !== true) return;
  for (const [name, ref] of [
    ["operator.opentofuApplyRef", input.operator.opentofuApplyRef],
    ["outputs.ref", input.outputs.ref],
  ] as const) {
    if (!ACCEPTED_LIVE_REF_PREFIXES.some((prefix) => ref.startsWith(prefix))) {
      throw new Error(
        `${name} must use a private artifact ref for live proof: ${
          ACCEPTED_LIVE_REF_PREFIXES.join(", ")
        }`,
      );
    }
  }
}

function normalizeSource(source: Source, baseDir: string): Source {
  if (source.kind !== "local") return source;
  return {
    ...source,
    url: resolveRelative(baseDir, source.url),
  };
}

function resolveRelative(baseDir: string, path: string): string {
  return isAbsolute(path) ? path : resolve(baseDir, path);
}

function digestBytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function digestJson(value: unknown): string {
  return digestBytes(Buffer.from(JSON.stringify(canonical(value))));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireNonEmptyString(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function parseCliArgs(args: readonly string[]): RunOpenTofuBindingSnapshotProofOptions {
  const options: { inputPath?: string; outputPath?: string } = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--input") {
      options.inputPath = requireNext(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--output") {
      options.outputPath = requireNext(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function requireNext(
  args: readonly string[],
  index: number,
  flag: string,
): string {
  const value = args[index + 1];
  if (!value) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function printHelp(): void {
  console.log(`Usage: bun scripts/prove-opentofu-binding-snapshot.ts [--input proof-input.json] [--output proof.json]

Verifies operator-supplied tofu output -json can be imported into
PlatformService inventory and recorded as a Deployment bindingsSnapshot.
Takosumi does not run OpenTofu in this proof.`);
}

if (import.meta.main) {
  try {
    const proof = await runOpenTofuBindingSnapshotProof(
      parseCliArgs(process.argv.slice(2)),
    );
    console.log(JSON.stringify(proof, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
