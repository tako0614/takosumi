#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { dirname, isAbsolute, resolve } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { JsonValue } from "takosumi-contract";
import type {
  DeploymentOutput,
  OpenTofuModuleSource,
  OpenTofuOutputEnvelope,
  RunnerProfile,
} from "takosumi-contract/deploy-control-api";
import {
  extractDeploymentOutputs,
  parseOpenTofuOutputs,
  toDeployControlOutputEnvelope,
} from "../packages/platform-services/src/opentofu-output-resolver.ts";
import {
  applyExpectedGuardFromPlanRun,
  OpenTofuDeploymentController,
  type OpenTofuApplyJob,
  type OpenTofuPlanJob,
  type OpenTofuRunner,
} from "../src/service/domains/deploy-control/mod.ts";
import { InMemoryOpenTofuDeploymentStore } from "../src/service/domains/deploy-control/store.ts";
import { seedInstallationModel } from "../src/service/domains/deploy-control/test_model_fixture.ts";

const DEFAULT_INPUT =
  "fixtures/opentofu-deployment-output-proof/proof-input.json";
const PROOF_KIND = "takosumi.opentofu-deployment-output-proof@v1";
const INPUT_KIND = "takosumi.opentofu-deployment-output-proof-input@v1";
const ACCEPTED_LIVE_REF_PREFIXES = [
  "artifact://",
  "vault://",
  "s3://",
  "gs://",
  "r2://",
  "secret-manager://",
] as const;

export interface OpenTofuDeploymentOutputProofInput {
  readonly kind: typeof INPUT_KIND;
  readonly live?: boolean;
  readonly spaceId: string;
  readonly source: OpenTofuModuleSource;
  readonly runnerProfileId?: string;
  readonly requiredProviders?: readonly string[];
  readonly variables?: Readonly<Record<string, JsonValue>>;
  readonly outputKinds?: Readonly<Record<string, string>>;
  readonly outputs: {
    readonly file: string;
    readonly ref: string;
  };
  readonly operator: {
    readonly opentofuApplyRef: string;
  };
}

export interface OpenTofuDeploymentOutputProof {
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
    readonly planDigest: string;
    readonly providerLockDigest: string;
    readonly applyRunOutputsDigest: string;
    readonly deploymentOutputsDigest: string;
    readonly applyAuditEventCount: number;
    readonly stateLockStatus: string;
  };
  readonly source: OpenTofuModuleSource;
  readonly planRun: {
    readonly id: string;
    readonly status: string;
    readonly runnerProfileId: string;
  };
  readonly applyRun: {
    readonly id: string;
    readonly status: string;
  };
  readonly installation: {
    readonly id: string;
    readonly status: string;
    readonly currentDeploymentId: string | null;
  };
  readonly deployment: {
    readonly id: string;
    readonly status: string;
    readonly outputs: readonly DeploymentOutput[];
  };
  readonly checks: readonly {
    readonly name: string;
    readonly status: "passed";
    readonly message: string;
  }[];
}

export interface RunOpenTofuDeploymentOutputProofOptions {
  readonly inputPath?: string;
  readonly outputPath?: string;
  readonly now?: () => string;
}

export async function runOpenTofuDeploymentOutputProof(
  options: RunOpenTofuDeploymentOutputProofOptions = {},
): Promise<OpenTofuDeploymentOutputProof> {
  const inputPath = resolve(options.inputPath ?? DEFAULT_INPUT);
  const baseDir = dirname(inputPath);
  const inputBytes = await readFile(inputPath);
  const input = parseProofInput(JSON.parse(inputBytes.toString("utf8")));
  validateEvidenceRefs(input);

  const outputsPath = resolveRelative(baseDir, input.outputs.file);
  const outputBytes = await readFile(outputsPath);
  const parsedOutputs = parseOpenTofuOutputs(outputBytes.toString("utf8"));
  const outputEnvelope = toDeployControlOutputEnvelope(parsedOutputs);
  const expectedOutputs = extractDeploymentOutputs({
    outputs: parsedOutputs,
    outputKinds: input.outputKinds,
  });
  const source = normalizeSource(input.source, baseDir);
  const nowMs = Date.parse(options.now?.() ?? new Date().toISOString());
  const ids = deterministicIds();
  const runnerProfile = runnerProfileForInput(input, nowMs);
  const runner = new ProofRunner({
    outputEnvelope,
    outputsDigest: digestBytes(outputBytes),
  });
  // Installation-first model (spec §5): a plan/apply targets an existing
  // Installation row. Seed the Space-direct Installation model into the store and
  // attach a prior current Deployment so the apply guard
  // (`installationCurrentDeploymentId`) is satisfiable for this single-shot proof.
  const store = new InMemoryOpenTofuDeploymentStore();
  const seeded = await seedInstallationModel(store, {
    spaceId: input.spaceId,
    installationId: ids.next("inst"),
    sourceUrl: source.kind === "git" ? source.url : undefined,
  });
  const seedDeploymentId = ids.next("dep");
  await store.putInstallation({
    ...seeded.installation,
    currentDeploymentId: seedDeploymentId,
  });
  const controller = new OpenTofuDeploymentController({
    store,
    runner,
    runnerProfiles: [runnerProfile],
    defaultRunnerProfileId: runnerProfile.id,
    now: () => nowMs,
    newId: ids.next,
  });

  const plan = await controller.createPlanRun({
    spaceId: input.spaceId,
    installationId: seeded.installation.id,
    source,
    runnerProfileId: input.runnerProfileId ?? runnerProfile.id,
    requiredProviders: input.requiredProviders ?? [],
    variables: input.variables,
  });
  if (plan.planRun.status !== "succeeded") {
    throw new Error(
      `fixture PlanRun did not succeed: ${JSON.stringify(plan.planRun.diagnostics ?? [])}`,
    );
  }

  const applied = await controller.createApplyRun({
    planRunId: plan.planRun.id,
    expected: applyExpectedGuardFromPlanRun(plan.planRun),
    approval: {
      approvedBy: "takosumi-proof",
      approvedAt: nowMs,
      reason: "fixture output projection proof",
    },
  });
  if (applied.applyRun.status !== "succeeded") {
    throw new Error(
      `fixture ApplyRun did not succeed: ${JSON.stringify(applied.applyRun.diagnostics ?? [])}`,
    );
  }
  if (!applied.installation || !applied.deployment) {
    throw new Error("fixture ApplyRun did not materialize Installation/Deployment");
  }

  // §21 model: the ApplyRun keeps the full projected DeploymentOutput[] while the
  // Deployment records the public name -> value projection as `outputsPublic`.
  // The DeploymentOutput snapshot is the ApplyRun outputs; assert the Deployment's
  // public projection is exactly its name -> value reduction (same source).
  const deploymentOutputs = applied.applyRun.outputs ?? [];
  const applyRunOutputsDigest = digestJson(deploymentOutputs);
  const deploymentOutputsDigest = applyRunOutputsDigest;
  const expectedOutputsPublic = Object.fromEntries(
    deploymentOutputs.map((output) => [output.name, output.value]),
  );
  if (
    digestJson(applied.deployment.outputsPublic) !==
      digestJson(expectedOutputsPublic)
  ) {
    throw new Error("ApplyRun outputs do not match Deployment output snapshot");
  }
  if (deploymentOutputsDigest !== digestJson(expectedOutputs)) {
    throw new Error("Deployment outputs do not match well-known OpenTofu output projection");
  }

  const proof: OpenTofuDeploymentOutputProof = {
    kind: PROOF_KIND,
    status: "passed",
    generatedAt: options.now?.() ?? new Date(nowMs).toISOString(),
    live: input.live === true,
    operator: {
      opentofuApplyRef: input.operator.opentofuApplyRef,
      outputsRef: input.outputs.ref,
    },
    evidence: {
      inputDigest: digestBytes(inputBytes),
      outputsDigest: digestBytes(outputBytes),
      planDigest: plan.planRun.planDigest!,
      providerLockDigest: plan.planRun.providerLockDigest!,
      applyRunOutputsDigest,
      deploymentOutputsDigest,
      applyAuditEventCount: applied.applyRun.auditEvents.length,
      stateLockStatus: applied.applyRun.stateLock.status,
    },
    source,
    planRun: {
      id: plan.planRun.id,
      status: plan.planRun.status,
      runnerProfileId: plan.planRun.runnerProfileId,
    },
    applyRun: {
      id: applied.applyRun.id,
      status: applied.applyRun.status,
    },
    installation: {
      id: applied.installation.id,
      status: applied.installation.status,
      currentDeploymentId: applied.installation.currentDeploymentId ?? null,
    },
    deployment: {
      id: applied.deployment.id,
      status: applied.deployment.status,
      outputs: deploymentOutputs,
    },
    checks: [
      {
        name: "opentofu-output-import",
        status: "passed",
        message:
          "operator-supplied tofu output -json was parsed as DeploymentOutput evidence",
      },
      {
        name: "plan-apply-run-ledger",
        status: "passed",
        message:
          "PlanRun and ApplyRun records were created through the OpenTofu deploy control API",
      },
      {
        name: "deployment-output-snapshot",
        status: "passed",
        message:
          "successful apply outputs match the DeploymentOutput snapshot recorded on Deployment",
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

class ProofRunner implements OpenTofuRunner {
  readonly #outputEnvelope: OpenTofuOutputEnvelope;
  readonly #outputsDigest: string;

  constructor(input: {
    readonly outputEnvelope: OpenTofuOutputEnvelope;
    readonly outputsDigest: string;
  }) {
    this.#outputEnvelope = input.outputEnvelope;
    this.#outputsDigest = input.outputsDigest;
  }

  plan(job: OpenTofuPlanJob) {
    const providerLockDigest = digestJson({
      requiredProviders: job.planRun.requiredProviders,
      runnerProfileId: job.runnerProfile.id,
    });
    const planDigest = digestJson({
      source: job.planRun.source,
      variables: job.variables,
      requiredProviders: job.planRun.requiredProviders,
      outputsDigest: this.#outputsDigest,
    });
    return Promise.resolve({
      planDigest,
      planArtifact: {
        kind: "object-storage",
        ref: `proof://plans/${job.planRun.id}.tfplan`,
        digest: planDigest,
        contentType: "application/vnd.opentofu.plan",
      },
      requiredProviders: job.planRun.requiredProviders,
      providerLockDigest,
      sourceCommit: sourceCommitFromProofSource(job.planRun.source),
      summary: {
        add: 1,
        change: 0,
        destroy: 0,
      },
    });
  }

  apply(_job: OpenTofuApplyJob) {
    return Promise.resolve({
      outputs: this.#outputEnvelope,
    });
  }
}

function parseProofInput(value: unknown): OpenTofuDeploymentOutputProofInput {
  const input = record(value, "proof input");
  if (input.kind !== INPUT_KIND) {
    throw new Error(`proof input kind must be ${INPUT_KIND}`);
  }
  requireNonEmptyString(input.spaceId, "spaceId");
  const source = parseSource(input.source);
  const outputs = record(input.outputs, "outputs");
  requireNonEmptyString(outputs.file, "outputs.file");
  requireNonEmptyString(outputs.ref, "outputs.ref");
  const operator = record(input.operator, "operator");
  requireNonEmptyString(operator.opentofuApplyRef, "operator.opentofuApplyRef");
  return {
    kind: INPUT_KIND,
    live: input.live === true,
    spaceId: input.spaceId,
    source,
    runnerProfileId: typeof input.runnerProfileId === "string"
      ? input.runnerProfileId
      : undefined,
    requiredProviders: Array.isArray(input.requiredProviders)
      ? input.requiredProviders.map((entry) => {
        requireNonEmptyString(entry, "requiredProviders[]");
        return entry;
      })
      : undefined,
    variables: isRecord(input.variables)
      ? input.variables as Readonly<Record<string, JsonValue>>
      : undefined,
    outputKinds: isStringRecord(input.outputKinds)
      ? input.outputKinds
      : undefined,
    outputs: {
      file: outputs.file,
      ref: outputs.ref,
    },
    operator: {
      opentofuApplyRef: operator.opentofuApplyRef,
    },
  };
}

function parseSource(value: unknown): OpenTofuModuleSource {
  const source = record(value, "source");
  switch (source.kind) {
    case "git":
      requireNonEmptyString(source.url, "source.url");
      return {
        kind: "git",
        url: source.url,
        ref: optionalString(source.ref),
        commit: optionalString(source.commit),
        modulePath: optionalString(source.modulePath),
      };
    case "prepared":
      requireNonEmptyString(source.url, "source.url");
      requireNonEmptyString(source.digest, "source.digest");
      return {
        kind: "prepared",
        url: source.url,
        digest: source.digest,
        modulePath: optionalString(source.modulePath),
      };
    case "local":
      requireNonEmptyString(source.path, "source.path");
      return {
        kind: "local",
        path: source.path,
        modulePath: optionalString(source.modulePath),
      };
    default:
      throw new Error("source.kind must be git, prepared, or local");
  }
}

function validateEvidenceRefs(input: OpenTofuDeploymentOutputProofInput): void {
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

function runnerProfileForInput(
  input: OpenTofuDeploymentOutputProofInput,
  now: number,
): RunnerProfile {
  return {
    id: input.runnerProfileId ?? "cloudflare-default",
    name: "Fixture Cloudflare Container runner",
    substrate: "cloudflare-containers",
    stateBackend: {
      kind: "operator-managed",
      ref: "state://fixture/opentofu-proof",
      lock: {
        kind: "operator",
        ref: "lock://fixture/opentofu-proof",
      },
    },
    allowedProviders: input.requiredProviders?.length
      ? input.requiredProviders
      : ["*"],
    sourcePolicy: { allowLocalSource: true },
    createdAt: now,
  };
}

function normalizeSource(
  source: OpenTofuModuleSource,
  baseDir: string,
): OpenTofuModuleSource {
  if (source.kind !== "local") return source;
  return {
    ...source,
    path: resolveRelative(baseDir, source.path),
  };
}

function sourceCommitFromProofSource(source: OpenTofuModuleSource): string {
  if (source.kind === "git" && source.commit) return source.commit;
  return digestJson(source);
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

function deterministicIds(): { next: (prefix: string) => string } {
  let index = 0;
  return {
    next(prefix: string): string {
      index += 1;
      return `${prefix}_fixture${String(index).padStart(8, "0")}`;
    },
  };
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

function isStringRecord(
  value: unknown,
): value is Readonly<Record<string, string>> {
  if (!isRecord(value)) return false;
  return Object.values(value).every((entry) => typeof entry === "string");
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  requireNonEmptyString(value, "optional string");
  return value;
}

function requireNonEmptyString(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function parseCliArgs(
  args: readonly string[],
): RunOpenTofuDeploymentOutputProofOptions {
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
  console.log(`Usage: bun scripts/prove-opentofu-deployment-output.ts [--input proof-input.json] [--output proof.json]

Verifies operator-supplied tofu output -json can be recorded as DeploymentOutput
through PlanRun and ApplyRun.`);
}

if (import.meta.main) {
  try {
    const proof = await runOpenTofuDeploymentOutputProof(
      parseCliArgs(process.argv.slice(2)),
    );
    console.log(JSON.stringify(proof, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
