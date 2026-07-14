#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { dirname, isAbsolute, resolve } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { JsonValue } from "takosumi-contract";
import type {
  OpenTofuModuleSource,
  OpenTofuOutputEnvelope,
  RunnerProfile,
} from "@takosumi/internal/deploy-control-api";
import {
  parseOpenTofuOutputs,
  toDeployControlOutputEnvelope,
} from "./opentofu-output.ts";
import {
  applyExpectedGuardFromPlanRun,
  DEFAULT_OPENTOFU_RUNNER_EXECUTOR_ID,
  OpenTofuController,
  type OpenTofuApplyJob,
  type OpenTofuPlanJob,
  type OpenTofuRunner,
} from "../../core/domains/deploy-control/mod.ts";
import { InMemoryOpenTofuControlStore } from "../../core/domains/deploy-control/store.ts";
import { ObjectKeyArtifactReferenceAllocator } from "../../core/adapters/storage/artifact-references.ts";
import {
  FIXTURE_AWS_MIRROR_EVIDENCE,
  FIXTURE_AWS_PROVIDER,
  FIXTURE_CLOUDFLARE_MIRROR_EVIDENCE,
  FIXTURE_CLOUDFLARE_PROVIDER,
  fakeProviderVault,
  seedCapsuleModel,
  seedProviderConnections,
} from "../helpers/deploy-control/model_fixture.ts";

const DEFAULT_INPUT =
  "fixtures/opentofu-output-snapshot-proof/proof-input.json";
const PROOF_KIND = "takosumi.opentofu-output-snapshot-proof@v1";
const INPUT_KIND = "takosumi.opentofu-output-snapshot-proof-input@v1";
const ACCEPTED_LIVE_REF_PREFIXES = [
  "artifact://",
  "vault://",
  "s3://",
  "gs://",
  "r2://",
  "secret-manager://",
] as const;

export interface OpenTofuOutputProofInput {
  readonly kind: typeof INPUT_KIND;
  readonly live?: boolean;
  readonly workspaceId: string;
  readonly source: OpenTofuModuleSource;
  readonly runnerProfileId?: string;
  readonly requiredProviders?: readonly string[];
  readonly variables?: Readonly<Record<string, JsonValue>>;
  readonly outputKinds: Readonly<Record<string, string>>;
  readonly outputs: {
    readonly file: string;
    readonly ref: string;
  };
  readonly operator: {
    readonly opentofuApplyRef: string;
  };
}

export interface OpenTofuOutputProof {
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
    readonly outputDigest: string;
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
  readonly capsule: {
    readonly id: string;
    readonly status: string;
    readonly currentStateVersionId: string | null;
  };
  readonly stateVersion: {
    readonly id: string;
    readonly generation: number;
    readonly createdByRunId: string;
  };
  readonly output: {
    readonly id: string;
    readonly stateGeneration: number;
    readonly publicOutputs: Readonly<Record<string, JsonValue>>;
    readonly workspaceOutputs: Readonly<Record<string, JsonValue>>;
    readonly outputDigest: string;
  };
  readonly checks: readonly {
    readonly name: string;
    readonly status: "passed";
    readonly message: string;
  }[];
}

export interface RunOpenTofuOutputProofOptions {
  readonly inputPath?: string;
  readonly outputPath?: string;
  readonly now?: () => string;
}

export async function runOpenTofuOutputProof(
  options: RunOpenTofuOutputProofOptions = {},
): Promise<OpenTofuOutputProof> {
  const inputPath = resolve(options.inputPath ?? DEFAULT_INPUT);
  const baseDir = dirname(inputPath);
  const inputBytes = await readFile(inputPath);
  const input = parseProofInput(JSON.parse(inputBytes.toString("utf8")));
  validateEvidenceRefs(input);

  const outputsPath = resolveRelative(baseDir, input.outputs.file);
  const outputBytes = await readFile(outputsPath);
  const parsedOutputs = parseOpenTofuOutputs(outputBytes.toString("utf8"));
  const outputEnvelope = toDeployControlOutputEnvelope(parsedOutputs);
  const expectedPublicOutputs = projectProofOutputs(
    outputEnvelope,
    input.outputKinds,
  );
  const source = normalizeSource(input.source, baseDir);
  const nowMs = Date.parse(options.now?.() ?? new Date().toISOString());
  const ids = deterministicIds();
  const runnerProfile = runnerProfileForInput(input, nowMs);
  const runner = new ProofRunner({
    outputEnvelope,
    outputsDigest: digestBytes(outputBytes),
  });
  // A plan/apply targets an existing Capsule. Attach a prior state pointer so
  // the apply guard (`capsuleCurrentStateVersionId`) is satisfiable for this
  // single-shot proof.
  const store = new InMemoryOpenTofuControlStore();
  const seeded = await seedCapsuleModel(store, {
    workspaceId: input.workspaceId,
    capsuleId: ids.next("cap"),
    sourceUrl: source.kind === "git" ? source.url : undefined,
    installConfig: {
      outputAllowlist: Object.fromEntries(
        Object.keys(expectedPublicOutputs).map((name) => [
          name,
          {
            from: name,
            type: input.outputKinds[name]?.endsWith("_url") ? "url" : "json",
          },
        ]),
      ),
    },
  });
  await seedProviderConnections(store, seeded.capsule, {
    requiredProviders: input.requiredProviders,
  });
  const previousStateVersionId = ids.next("state");
  await store.putCapsule({
    ...seeded.capsule,
    currentStateVersionId: previousStateVersionId,
  });
  const controller = new OpenTofuController({
    store,
    runner,
    runnerProfiles: [runnerProfile],
    defaultRunnerProfileId: runnerProfile.id,
    vault: fakeProviderVault() as never,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    now: () => nowMs,
    newId: ids.next,
  });

  const plan = await controller.createCapsulePlan(seeded.capsule.id);
  if (plan.planRun.status !== "succeeded") {
    throw new Error(
      `fixture plan Run did not succeed: ${JSON.stringify(plan.planRun.diagnostics ?? [])}`,
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
      `fixture apply Run did not succeed: ${JSON.stringify(applied.applyRun.diagnostics ?? [])}`,
    );
  }
  if (!applied.capsule) {
    throw new Error("fixture apply Run did not return its Capsule projection");
  }
  const stateVersionId = applied.applyRun.stateVersionId;
  const outputId = applied.applyRun.outputId;
  if (!stateVersionId || !outputId) {
    throw new Error(
      "successful apply did not record StateVersion and Output ids",
    );
  }
  const stateVersion = await store.getStateVersion(stateVersionId);
  const output = await store.getOutput(outputId);
  if (!stateVersion || !output) {
    throw new Error("successful apply ledger pointers do not resolve");
  }
  const applyRunOutputsDigest = digestJson(output.publicOutputs);
  if (applyRunOutputsDigest !== digestJson(expectedPublicOutputs)) {
    throw new Error(
      "canonical Output.publicOutputs does not match the explicit service-side mapping",
    );
  }

  const proof: OpenTofuOutputProof = {
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
      outputDigest: output.outputDigest,
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
    capsule: {
      id: applied.capsule.id,
      status: applied.capsule.status,
      currentStateVersionId: applied.capsule.currentStateVersionId ?? null,
    },
    stateVersion: {
      id: stateVersion.id,
      generation: stateVersion.generation,
      createdByRunId: stateVersion.createdByRunId,
    },
    output: {
      id: output.id,
      stateGeneration: output.stateGeneration,
      publicOutputs: output.publicOutputs,
      workspaceOutputs: output.workspaceOutputs,
      outputDigest: output.outputDigest,
    },
    checks: [
      {
        name: "opentofu-output-import",
        status: "passed",
        message:
          "operator-supplied tofu output -json was parsed as Output projection evidence",
      },
      {
        name: "run-ledger",
        status: "passed",
        message:
          "internal plan/apply compatibility records were created through the OpenTofu deploy control API",
      },
      {
        name: "state-version-output-ledger",
        status: "passed",
        message:
          "successful apply recorded canonical StateVersion and Output rows without a second compatibility ledger",
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
      providerInstallation: providerInstallationEvidenceFor(
        job.planRun.requiredProviders,
      ),
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

function projectProofOutputs(
  outputs: OpenTofuOutputEnvelope,
  outputKinds: Readonly<Record<string, string>>,
): Readonly<Record<string, JsonValue>> {
  const projected: Record<string, JsonValue> = {};
  for (const name of Object.keys(outputKinds)) {
    const output = outputs[name];
    if (!output) {
      throw new Error(`mapped OpenTofu output ${name} is missing`);
    }
    if (output.sensitive === true) {
      throw new Error(`mapped OpenTofu output ${name} is sensitive`);
    }
    projected[name] = output.value;
  }
  return projected;
}

function parseProofInput(value: unknown): OpenTofuOutputProofInput {
  const input = record(value, "proof input");
  if (input.kind !== INPUT_KIND) {
    throw new Error(`proof input kind must be ${INPUT_KIND}`);
  }
  requireNonEmptyString(input.workspaceId, "workspaceId");
  const source = parseSource(input.source);
  const outputs = record(input.outputs, "outputs");
  requireNonEmptyString(outputs.file, "outputs.file");
  requireNonEmptyString(outputs.ref, "outputs.ref");
  const operator = record(input.operator, "operator");
  requireNonEmptyString(operator.opentofuApplyRef, "operator.opentofuApplyRef");
  return {
    kind: INPUT_KIND,
    live: input.live === true,
    workspaceId: input.workspaceId,
    source,
    runnerProfileId:
      typeof input.runnerProfileId === "string"
        ? input.runnerProfileId
        : undefined,
    requiredProviders: Array.isArray(input.requiredProviders)
      ? input.requiredProviders.map((entry) => {
          requireNonEmptyString(entry, "requiredProviders[]");
          return entry;
        })
      : undefined,
    variables: isRecord(input.variables)
      ? (input.variables as Readonly<Record<string, JsonValue>>)
      : undefined,
    outputKinds: requiredStringRecord(input.outputKinds, "outputKinds"),
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
  if (source.kind !== "git") {
    throw new Error("source.kind must be git");
  }
  requireNonEmptyString(source.url, "source.url");
  return {
    kind: "git",
    url: source.url,
    ref: optionalString(source.ref),
    commit: optionalString(source.commit),
    modulePath: optionalString(source.modulePath),
  };
}

function validateEvidenceRefs(input: OpenTofuOutputProofInput): void {
  if (input.live !== true) return;
  for (const [name, ref] of [
    ["operator.opentofuApplyRef", input.operator.opentofuApplyRef],
    ["outputs.ref", input.outputs.ref],
  ] as const) {
    if (!ACCEPTED_LIVE_REF_PREFIXES.some((prefix) => ref.startsWith(prefix))) {
      throw new Error(
        `${name} must use a private artifact ref for live proof: ${ACCEPTED_LIVE_REF_PREFIXES.join(
          ", ",
        )}`,
      );
    }
  }
}

function runnerProfileForInput(
  input: OpenTofuOutputProofInput,
  now: number,
): RunnerProfile {
  return {
    id: input.runnerProfileId ?? "opentofu-default",
    name: "Fixture Cloudflare Container runner",
    substrate: "cloudflare-containers",
    executorId: DEFAULT_OPENTOFU_RUNNER_EXECUTOR_ID,
    lifecycle: { state: "active" },
    availability: { state: "available" },
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
    createdAt: now,
  };
}

function normalizeSource(
  source: OpenTofuModuleSource,
  _baseDir: string,
): OpenTofuModuleSource {
  return source;
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

function providerInstallationEvidenceFor(providers: readonly string[]) {
  return providers.flatMap((provider) => {
    if (provider === FIXTURE_CLOUDFLARE_PROVIDER) {
      return [FIXTURE_CLOUDFLARE_MIRROR_EVIDENCE];
    }
    if (provider === FIXTURE_AWS_PROVIDER) {
      return [FIXTURE_AWS_MIRROR_EVIDENCE];
    }
    return [
      {
        provider,
        mirrored: true,
        installationMethod: "filesystem_mirror" as const,
        attested: true,
        attestationMethod: "forced_filesystem_mirror_init" as const,
        mirrorPath: `/opt/opentofu/provider-mirror/${provider}`,
      },
    ];
  });
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

function requiredStringRecord(
  value: unknown,
  label: string,
): Readonly<Record<string, string>> {
  if (
    !isStringRecord(value) ||
    Object.keys(value).length === 0 ||
    Object.entries(value).some(
      ([name, kind]) => name.trim().length === 0 || kind.trim().length === 0,
    )
  ) {
    throw new Error(`${label} must be a non-empty string map`);
  }
  return value;
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

function parseCliArgs(args: readonly string[]): RunOpenTofuOutputProofOptions {
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
  console.log(`Usage: bun tests/proofs/opentofu-output-snapshot.ts [--input proof-input.json] [--output proof.json]

Verifies operator-supplied tofu output -json can be recorded as an Output
projection through the OpenTofu Run ledger.`);
}

if (import.meta.main) {
  try {
    const proof = await runOpenTofuOutputProof(
      parseCliArgs(process.argv.slice(2)),
    );
    console.log(JSON.stringify(proof, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
