#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { access, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import type {
  OpenTofuOutputEnvelope,
  RunnerProfile,
} from "@takosumi/internal/deploy-control-api";
import {
  applyExpectedGuardFromPlanRun,
  DEFAULT_OPENTOFU_RUNNER_EXECUTOR_ID,
  OpenTofuController,
  type OpenTofuApplyJob,
  type OpenTofuDestroyJob,
  type OpenTofuPlanJob,
  type OpenTofuRunner,
} from "../../core/domains/deploy-control/mod.ts";
import { InMemoryOpenTofuControlStore } from "../../core/domains/deploy-control/store.ts";
import { ObjectKeyArtifactReferenceAllocator } from "../../core/adapters/storage/artifact-references.ts";
import { seedCapsuleModel } from "../helpers/deploy-control/model_fixture.ts";
import { parseOpenTofuOutputs } from "./opentofu-output.ts";

const FIXTURE_SOURCE = "fixtures/opentofu-output-snapshot-proof/source";
const PROOF_KIND = "takosumi.live-local-opentofu-plan-apply-proof@v1";

export interface LiveOpenTofuPlanApplyProof {
  readonly kind: typeof PROOF_KIND;
  readonly status: "passed";
  readonly generatedAt: string;
  readonly tofuVersion: string;
  readonly runnerProfileId: string;
  readonly evidence: {
    readonly planDigest: string;
    readonly outputCount: number;
    readonly stateLockStatus: string;
    readonly applyAuditEventCount: number;
    readonly providerSource: string;
    readonly destroyStatus: "succeeded";
    readonly resourceRemoved: boolean;
  };
}

export async function runLiveOpenTofuPlanApplyProof(
  options: {
    readonly outputPath?: string;
    readonly now?: () => string;
  } = {},
): Promise<LiveOpenTofuPlanApplyProof> {
  const tofuVersion = (
    await runTofu(["version", "-json"], process.cwd())
  ).trim();
  const temp = await mkdtemp(`${tmpdir()}/takosumi-live-tofu-`);
  try {
    const workdir = `${temp}/module`;
    await cp(resolve(FIXTURE_SOURCE), workdir, { recursive: true });
    const runnerProfile = liveLocalRunnerProfile(Date.now());
    const ids = deterministicIds();
    // Capsule-first model: seed the Workspace-owned Capsule
    // and attach a prior current StateVersion pointer so this single-shot proof's
    // apply passes the `capsuleCurrentStateVersionId` guard.
    const store = new InMemoryOpenTofuControlStore();
    const seeded = await seedCapsuleModel(store, {
      workspaceId: "ws_live_local",
      capsuleId: ids.next("cap"),
      installConfig: {
        outputAllowlist: {
          provider_proof_path: {
            from: "provider_proof_path",
            type: "string",
          },
        },
      },
    });
    await store.putCapsule({
      ...seeded.capsule,
      currentStateVersionId: ids.next("state"),
    });
    const controller = new OpenTofuController({
      store,
      runner: new LocalTofuRunner(workdir),
      runnerProfiles: [runnerProfile],
      defaultRunnerProfileId: runnerProfile.id,
      artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
      now: () => Date.parse(options.now?.() ?? new Date().toISOString()),
      newId: ids.next,
    });
    const planned = await controller.createCapsulePlan(seeded.capsule.id);
    if (planned.planRun.status !== "succeeded") {
      throw new Error(
        `PlanRun failed: ${JSON.stringify(planned.planRun.diagnostics ?? [])}`,
      );
    }
    const applied = await controller.createApplyRun({
      planRunId: planned.planRun.id,
      expected: applyExpectedGuardFromPlanRun(planned.planRun),
      approval: {
        approvedBy: "takosumi-live-local-proof",
        approvedAt: Date.parse(options.now?.() ?? new Date().toISOString()),
        reason: "local non-production OpenTofu proof",
      },
    });
    if (applied.applyRun.status !== "succeeded") {
      throw new Error(
        `ApplyRun failed: ${JSON.stringify(applied.applyRun.diagnostics ?? [])}`,
      );
    }
    const proofFile = `${workdir}/takosumi-provider-proof.txt`;
    await access(proofFile);
    const destroyPlan = await controller.createCapsuleDestroyPlan(
      seeded.capsule.id,
    );
    await controller.approveRun(destroyPlan.planRun.id);
    const destroyed = await controller.createApplyRun({
      planRunId: destroyPlan.planRun.id,
      expected: applyExpectedGuardFromPlanRun(destroyPlan.planRun),
    });
    if (destroyed.applyRun.status !== "succeeded") {
      throw new Error(
        `Destroy failed: ${JSON.stringify(destroyed.applyRun.diagnostics ?? [])}`,
      );
    }
    const output = applied.applyRun.outputId
      ? await store.getOutput(applied.applyRun.outputId)
      : undefined;
    if (!output) {
      throw new Error("ApplyRun succeeded without a canonical Output row");
    }
    const resourceRemoved = await access(proofFile).then(
      () => false,
      () => true,
    );
    const proof: LiveOpenTofuPlanApplyProof = {
      kind: PROOF_KIND,
      status: "passed",
      generatedAt: options.now?.() ?? new Date().toISOString(),
      tofuVersion,
      runnerProfileId: runnerProfile.id,
      evidence: {
        planDigest: planned.planRun.planDigest!,
        outputCount: Object.keys(output.publicOutputs).length,
        stateLockStatus: applied.applyRun.stateLock.status,
        applyAuditEventCount: applied.applyRun.auditEvents.length,
        providerSource: "registry.opentofu.org/hashicorp/local",
        destroyStatus: "succeeded",
        resourceRemoved,
      },
    };
    if (proof.evidence.outputCount < 1) {
      throw new Error(
        "live local OpenTofu proof did not record Output projection",
      );
    }
    if (!proof.evidence.resourceRemoved) {
      throw new Error(
        "live local OpenTofu proof did not destroy the provider resource",
      );
    }
    if (options.outputPath) {
      const outputPath = resolve(options.outputPath);
      await writeFile(outputPath, `${JSON.stringify(proof, null, 2)}\n`);
    }
    return proof;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

class LocalTofuRunner implements OpenTofuRunner {
  readonly #workdir: string;

  constructor(workdir: string) {
    this.#workdir = workdir;
  }

  async plan(job: OpenTofuPlanJob) {
    await runTofu(["init", "-input=false", "-no-color"], this.#workdir);
    await runTofu(
      [
        "plan",
        ...(job.planRun.operation === "destroy" ? ["-destroy"] : []),
        "-input=false",
        "-no-color",
        "-out=tfplan",
      ],
      this.#workdir,
    );
    const planJson = await runTofu(["show", "-json", "tfplan"], this.#workdir);
    const planDigest = digestBytes(new TextEncoder().encode(planJson));
    const providerLockDigest = digestBytes(
      await readFile(`${this.#workdir}/.terraform.lock.hcl`),
    );
    return {
      planDigest,
      planArtifact: {
        kind: "runner-local",
        ref: `${this.#workdir}/tfplan`,
        digest: planDigest,
        contentType: "application/vnd.opentofu.plan",
      },
      sourceCommit: digestJson(job.planRun.source),
      providerLockDigest,
      requiredProviders: ["registry.opentofu.org/hashicorp/local"],
      providerInstallation: [localProviderInstallationEvidence()],
      summary: summarizePlanJson(planJson),
    };
  }

  async apply(_job: OpenTofuApplyJob) {
    await runTofu(
      ["apply", "-input=false", "-no-color", "tfplan"],
      this.#workdir,
    );
    const outputs = await runTofu(["output", "-json"], this.#workdir);
    return {
      outputs: parseOpenTofuOutputs(outputs) as OpenTofuOutputEnvelope,
      stateDigest: digestBytes(
        await readFile(`${this.#workdir}/terraform.tfstate`),
      ),
      providerInstallation: [localProviderInstallationEvidence()],
    };
  }

  async destroy(_job: OpenTofuDestroyJob) {
    await runTofu(
      ["apply", "-input=false", "-no-color", "tfplan"],
      this.#workdir,
    );
    return {
      stateDigest: digestBytes(
        await readFile(`${this.#workdir}/terraform.tfstate`),
      ),
      providerInstallation: [localProviderInstallationEvidence()],
    };
  }
}

function localProviderInstallationEvidence() {
  return {
    provider: "registry.opentofu.org/hashicorp/local",
    mirrored: false,
    installationMethod: "direct" as const,
    attested: false,
  };
}

function summarizePlanJson(planJson: string) {
  const parsed = JSON.parse(planJson) as {
    readonly resource_changes?: readonly {
      readonly change?: { readonly actions?: readonly string[] };
    }[];
  };
  let add = 0;
  let change = 0;
  let destroy = 0;
  for (const entry of parsed.resource_changes ?? []) {
    const actions = entry.change?.actions ?? [];
    if (actions.includes("create")) add++;
    if (actions.includes("update")) change++;
    if (actions.includes("delete")) destroy++;
  }
  return { add, change, destroy };
}

function liveLocalRunnerProfile(now: number): RunnerProfile {
  return {
    id: "opentofu-default",
    name: "OpenTofu default live proof",
    substrate: "local",
    executorId: DEFAULT_OPENTOFU_RUNNER_EXECUTOR_ID,
    lifecycle: { state: "active" },
    availability: { state: "available" },
    tofuVersion: "operator-managed",
    stateBackend: {
      kind: "local",
      ref: "state://fixture/opentofu-default",
      lock: { kind: "operator", ref: "lock://fixture/opentofu-default" },
    },
    allowedProviders: ["*"],
    requireProviderBindings: false,
    resourceLimits: { maxRunSeconds: 120, cpu: "1", memoryMb: 512 },
    networkPolicy: { mode: "operator-managed" },
    createdAt: now,
  };
}

function deterministicIds(): { next(prefix: string): string } {
  let next = 1;
  return {
    next(prefix: string) {
      return `${prefix}_${String(next++).padStart(8, "0")}`;
    },
  };
}

async function runTofu(args: readonly string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(["tofu", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new Response(proc.stdout).text();
  const stderr = new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  const [out, err] = await Promise.all([stdout, stderr]);
  if (exitCode !== 0) {
    throw new Error(`tofu ${args.join(" ")} failed with ${exitCode}: ${err}`);
  }
  return out;
}

function digestBytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function digestJson(value: unknown): string {
  return digestBytes(Buffer.from(JSON.stringify(canonical(value))));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}

if (import.meta.main) {
  const outputIndex = process.argv.indexOf("--output");
  const outputPath =
    outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined;
  const proof = await runLiveOpenTofuPlanApplyProof({
    ...(outputPath ? { outputPath } : {}),
  });
  console.log(JSON.stringify(proof, null, 2));
}
