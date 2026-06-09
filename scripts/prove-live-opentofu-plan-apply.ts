#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import type {
  OpenTofuOutputEnvelope,
  RunnerProfile,
} from "@takosumi/internal/deploy-control-api";
import {
  applyExpectedGuardFromPlanRun,
  OpenTofuDeploymentController,
  type OpenTofuApplyJob,
  type OpenTofuPlanJob,
  type OpenTofuRunner,
} from "../src/service/domains/deploy-control/mod.ts";
import { InMemoryOpenTofuDeploymentStore } from "../src/service/domains/deploy-control/store.ts";
import { seedInstallationModel } from "../src/service/domains/deploy-control/test_model_fixture.ts";
import { parseOpenTofuOutputs } from "../packages/platform-services/src/opentofu-output-resolver.ts";

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
  };
}

export async function runLiveOpenTofuPlanApplyProof(options: {
  readonly outputPath?: string;
  readonly now?: () => string;
} = {}): Promise<LiveOpenTofuPlanApplyProof> {
  const tofuVersion = (await runTofu(["version", "-json"], process.cwd())).trim();
  const temp = await mkdtemp(`${tmpdir()}/takosumi-live-tofu-`);
  try {
    const workdir = `${temp}/module`;
    await cp(resolve(FIXTURE_SOURCE), workdir, { recursive: true });
    const runnerProfile = liveLocalRunnerProfile(Date.now());
    const ids = deterministicIds();
    // Capsule Installation model: seed the Space-direct Installation
    // model and attach a prior current Deployment so this single-shot proof's
    // apply passes the `installationCurrentDeploymentId` guard.
    const store = new InMemoryOpenTofuDeploymentStore();
    const seeded = await seedInstallationModel(store, {
      spaceId: "space_live_local",
      installationId: ids.next("inst"),
      installConfig: {
        outputAllowlist: {
          takosumi_launch_url: {
            from: "takosumi_launch_url",
            type: "url",
          },
          takosumi_admin_url: {
            from: "takosumi_admin_url",
            type: "url",
          },
          health_url: {
            from: "health_url",
            type: "url",
          },
        },
      },
    });
    await store.putInstallation({
      ...seeded.installation,
      currentDeploymentId: ids.next("dep"),
    });
    const controller = new OpenTofuDeploymentController({
      store,
      runner: new LocalTofuRunner(workdir),
      runnerProfiles: [runnerProfile],
      defaultRunnerProfileId: runnerProfile.id,
      now: () => Date.parse(options.now?.() ?? new Date().toISOString()),
      newId: ids.next,
    });
    const planned = await controller.createInstallationPlan(
      seeded.installation.id,
    );
    if (planned.planRun.status !== "succeeded") {
      throw new Error(`PlanRun failed: ${JSON.stringify(planned.planRun.diagnostics ?? [])}`);
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
      throw new Error(`ApplyRun failed: ${JSON.stringify(applied.applyRun.diagnostics ?? [])}`);
    }
    const proof: LiveOpenTofuPlanApplyProof = {
      kind: PROOF_KIND,
      status: "passed",
      generatedAt: options.now?.() ?? new Date().toISOString(),
      tofuVersion,
      runnerProfileId: runnerProfile.id,
      evidence: {
        planDigest: planned.planRun.planDigest!,
        // The internal apply compatibility output list feeds the
        // OutputSnapshot projection; Deployment records the public projection
        // as `outputsPublic`.
        outputCount: applied.applyRun.outputs?.length ?? 0,
        stateLockStatus: applied.applyRun.stateLock.status,
        applyAuditEventCount: applied.applyRun.auditEvents.length,
      },
    };
    if (proof.evidence.outputCount < 1) {
      throw new Error("live local OpenTofu proof did not record OutputSnapshot projection");
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

  async plan(_job: OpenTofuPlanJob) {
    await runTofu(["init", "-input=false", "-no-color"], this.#workdir);
    await runTofu([
      "plan",
      "-input=false",
      "-no-color",
      "-out=tfplan",
    ], this.#workdir);
    const planJson = await runTofu(["show", "-json", "tfplan"], this.#workdir);
    const planDigest = digestBytes(new TextEncoder().encode(planJson));
    return {
      planDigest,
      planArtifact: {
        kind: "runner-local",
        ref: `${this.#workdir}/tfplan`,
        digest: planDigest,
        contentType: "application/vnd.opentofu.plan",
      },
      sourceCommit: digestJson({ kind: "local", path: this.#workdir }),
      summary: summarizePlanJson(planJson),
    };
  }

  async apply(_job: OpenTofuApplyJob) {
    await runTofu(["apply", "-input=false", "-no-color", "tfplan"], this.#workdir);
    const outputs = await runTofu(["output", "-json"], this.#workdir);
    return {
      outputs: parseOpenTofuOutputs(outputs) as OpenTofuOutputEnvelope,
    };
  }
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
    id: "live-local-proof",
    name: "Live local proof",
    substrate: "local",
    tofuVersion: "operator-managed",
    stateBackend: {
      kind: "local",
      ref: "state://fixture/live-local-proof",
      lock: { kind: "operator", ref: "lock://fixture/live-local-proof" },
    },
    allowedProviders: [],
    sourcePolicy: { allowLocalSource: true },
    resourceLimits: { maxRunSeconds: 120, cpu: "1", memoryMb: 512 },
    networkPolicy: { mode: "default-deny" },
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
  const outputPath = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined;
  const proof = await runLiveOpenTofuPlanApplyProof({
    ...(outputPath ? { outputPath } : {}),
  });
  console.log(JSON.stringify(proof, null, 2));
}
