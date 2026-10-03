import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapsuleCompatibilityReport } from "takosumi-contract/capsules";
import { sha256Digest } from "../../../../core/adapters/source/digest.ts";
import { PartitionedSecretBoundaryCrypto } from "../../../../core/adapters/secret-store/memory.ts";
import {
  ObjectKeyArtifactReferenceAllocator,
  type ArtifactReferenceAllocation,
} from "../../../../core/adapters/storage/artifact-references.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import {
  applyExpectedGuardFromPlanRun,
  type OpenTofuRunner,
} from "../../../../core/domains/deploy-control/mod.ts";
import { createTakosumiService } from "../../../../core/bootstrap.ts";
import {
  createFileOpenTofuStateArtifactStore,
  createHttpOpenTofuRunner,
  createLocalOpenTofuRunnerProfile,
} from "../../../../deploy/node-postgres/src/local-opentofu-runner.ts";
import { handleRunnerRequestWithDependencies } from "../../../../runner/entrypoint.ts";
import {
  FIXTURE_EXECUTION_EVIDENCE_AUTHORITY,
  seedCapsuleModel,
} from "../../../helpers/deploy-control/model_fixture.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";

const STATE_CRYPTO = new PartitionedSecretBoundaryCrypto({
  globalPassphrase: "local-v2-success-readback-test-passphrase-32-bytes",
});

function opaqueRefShape(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    return {
      type: "string",
      sha256: createHash("sha256").update(value).digest("hex"),
    };
  }
  if (value === null || value === undefined) return { type: String(value) };
  return {
    type: typeof value,
    constructor: Object.getPrototypeOf(value)?.constructor?.name ?? null,
    keys: Object.keys(value as object).sort(),
    jsonSha256: createHash("sha256").update(JSON.stringify(value)).digest("hex"),
  };
}

test("a lost successful local v2 ACK settles through Core once and commits its state and Output", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "takosumi-local-v2-core-"));
  const client = await PGliteSqlClient.create();
  const id = crypto.randomUUID().replaceAll("-", "");
  const applyMarker = join(tempDir, "provider-dispatches");
  const fakeBin = join(tempDir, "bin");
  const sourceDir = join(tempDir, "source");
  const archivePath = join(tempDir, "source.tar.zst");
  const previousPath = Bun.env.PATH;
  let runnerServer: ReturnType<typeof Bun.serve> | undefined;
  let ackLossProxy: ReturnType<typeof Bun.serve> | undefined;
  try {
    await mkdir(fakeBin, { recursive: true });
    await mkdir(sourceDir, { recursive: true });
    await writeFile(
      join(sourceDir, "main.tf"),
      'output "launch_url" { value = "https://app.example.test" }\n',
    );
    const tar = spawnSync("tar", ["--zstd", "-cf", archivePath, "-C", sourceDir, "."], {
      encoding: "utf8",
    });
    if (tar.status !== 0) throw new Error(`source archive fixture failed: ${tar.stderr}`);
    const archiveBytes = new Uint8Array(await readFile(archivePath));
    const archiveDigest = await sha256Digest(archiveBytes) as `sha256:${string}`;
    const stateArtifactStore = createFileOpenTofuStateArtifactStore(
      join(tempDir, "encrypted-state-artifacts"),
      STATE_CRYPTO,
    );

    const store = new SqlOpenTofuControlStore({ client });
    let coreCommitRawOutputRef: unknown;
    const commitRunState = store.commitRunState.bind(store);
    store.commitRunState = async (...args) => {
      if (args[0].output) coreCommitRawOutputRef = args[0].output.rawArtifactRef;
      return await commitRunState(...args);
    };
    const seeded = await seedCapsuleModel(store, {
      workspaceId: `workspace_local_v2_${id}`,
      capsuleId: `capsule_local_v2_${id}`,
      sourceId: `source_local_v2_${id}`,
      snapshotId: `snapshot_local_v2_${id}`,
      installConfigId: `config_local_v2_${id}`,
      environment: "integration",
      name: "local-v2-success",
    });
    await store.putSourceSnapshot({
      ...seeded.snapshot,
      archiveDigest,
      archiveSizeBytes: archiveBytes.byteLength,
      repositoryInstallMetadata: { status: "absent" },
      repositoryManifest: { status: "absent" },
      repositoryModules: {
        status: "ready",
        scopePath: ".",
        modules: [{ path: ".", providerPackages: [], rootProviderRequirements: [] }],
      },
    });
    const compatibilityReport: CapsuleCompatibilityReport = {
      id: `compatibility_local_v2_${id}`,
      sourceId: seeded.source.id,
      sourceSnapshotId: seeded.snapshot.id,
      capsuleId: seeded.capsule.id,
      modulePath: ".",
      level: "ready",
      findings: [],
      providerPackages: [],
      rootProviderRequirements: [],
      resources: [],
      dataSources: [],
      provisioners: [],
      createdAt: "2026-10-03T00:00:00.000Z",
    };
    await store.putCapsuleCompatibilityReport(compatibilityReport);
    await store.patchCapsule(seeded.capsule.id, {
      compatibilityReportId: compatibilityReport.id,
      compatibilityStatus: compatibilityReport.level,
      updatedAt: "2026-10-03T00:00:00.000Z",
    });

    const profile = createLocalOpenTofuRunnerProfile(1);
    const rawOutputRefs: string[] = [];
    const objectKeyAllocator = new ObjectKeyArtifactReferenceAllocator();
    const artifactReferenceAllocator = {
      allocate(input: ArtifactReferenceAllocation) {
        const ref = objectKeyAllocator.allocate(input);
        if (input.kind === "raw_output") rawOutputRefs.push(ref);
        return ref;
      },
    };
    await writeFile(join(fakeBin, "tofu"), `#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  init|validate) echo ok ;;
  plan)
    while (($#)); do
      if [[ "$1" == "-out" ]]; then shift; printf 'fake-reviewed-plan' > "$1"; break; fi
      shift
    done
    ;;
  show) printf '{"format_version":"1.2","resource_changes":[],"planned_values":{"outputs":{"launch_url":{"value":"https://app.example.test","sensitive":false}}}}' ;;
  apply)
    printf 'dispatch\n' >> '${applyMarker}'
    cat > terraform.tfstate <<'JSON'
{"version":4,"serial":1,"lineage":"local-v2-${id}","outputs":{"launch_url":{"value":"https://app.example.test","type":"string"}},"resources":[]}
JSON
    ;;
  output) printf '{"launch_url":{"value":"https://app.example.test","sensitive":false,"type":"string"}}' ;;
  version) printf '{"terraform_version":"1.9.0"}' ;;
  *) echo "unexpected tofu command: $*" >&2; exit 2 ;;
esac
`);
    await chmod(join(fakeBin, "tofu"), 0o755);
    Bun.env.PATH = `${fakeBin}:${previousPath ?? ""}`;

    runnerServer = Bun.serve({
      port: 0,
      fetch: (request) => handleRunnerRequestWithDependencies(request, {
        mutationCustodyMode: "local-http",
        localPreparationV2: true,
      }),
    });
    let applyPosts = 0;
    let successfulApplyAcksDropped = 0;
    let applyCompletionReadsAfterAckLoss = 0;
    let applyRunIdFromDispatch: string | undefined;
    let preparationAttemptId: string | undefined;
    let preparationEpoch: string | undefined;
    let completionReadback: Record<string, unknown> | undefined;
    let completionReadbackAttemptId: string | null = null;
    let completionReadbackEpoch: string | null = null;
    const routedRequests: string[] = [];
    ackLossProxy = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        const path = url.pathname;
        routedRequests.push(`${request.method} ${path}`);
        let isApplyPost = false;
        if (request.method === "POST" && /^\/runs\/[^/]+$/u.test(path)) {
          const payload = await request.clone().json() as { action?: string };
          isApplyPost = payload.action === "apply";
          if (isApplyPost) {
            applyPosts += 1;
            applyRunIdFromDispatch = decodeURIComponent(path.split("/")[2]!);
          }
        }
        if (request.method === "GET" && /^\/runs\/apply_[^/]+\/completion$/u.test(path) && successfulApplyAcksDropped > 0) {
          applyCompletionReadsAfterAckLoss += 1;
          completionReadbackAttemptId = request.headers.get("x-takosumi-preparation-attempt");
          completionReadbackEpoch = request.headers.get("x-takosumi-preparation-epoch");
        }
        if (request.method === "PUT" && /^\/runs\/apply_[^/]+\/mutation-preparation$/u.test(path)) {
          const preparation = await request.clone().json() as { attemptId?: string };
          preparationAttemptId = preparation.attemptId;
        }
        if (request.method === "POST" && /^\/runs\/[^/]+\/plan-state-metadata$/u.test(path)) {
          // The injected tofu executable emits a fixture Plan, so provide the
          // exact no-prior-state metadata that a genuine empty-state Plan carries.
          return Response.json({ lineage: "", serial: 0 });
        }
        const upstream = await fetch(new Request(new URL(`${path}${url.search}`, runnerServer!.url), request));
        if (request.method === "PUT" && /^\/runs\/apply_[^/]+\/mutation-preparation$/u.test(path) && upstream.status === 201) {
          const reservation = await upstream.clone().json() as { epoch?: number };
          preparationEpoch = String(reservation.epoch);
        }
        if (request.method === "GET" && /^\/runs\/apply_[^/]+\/completion$/u.test(path) && successfulApplyAcksDropped > 0 && upstream.status === 200) {
          completionReadback = await upstream.clone().json() as Record<string, unknown>;
        }
        if (isApplyPost && upstream.status === 200) {
          // Consume the actual runner's 200 before simulating a transport ACK loss.
          await upstream.arrayBuffer();
          successfulApplyAcksDropped += 1;
          return Response.json(
            { errorCode: "injected_upstream_ack_lost" },
            { status: 502 },
          );
        }
        return upstream;
      },
    });

    const routedHttpRunner = createHttpOpenTofuRunner({
      archiveStore: { write: async () => {}, read: async () => archiveBytes },
      stateStore: stateArtifactStore,
      baseUrl: ackLossProxy.url.href,
    });
    let adapterReturnedRawOutputRef: unknown;
    const routedRunner: OpenTofuRunner = {
      plan: (job, control) => routedHttpRunner.plan(job, control),
      apply: async (job, control) => {
        const result = await routedHttpRunner.apply!(job, control);
        adapterReturnedRawOutputRef = result.rawOutputRef;
        return result;
      },
      destroy: (job, control) => routedHttpRunner.destroy!(job, control),
    };
    const created = await createTakosumiService({
      role: "takosumi-api",
      runtimeEnv: { TAKOSUMI_DEV_MODE: "1", TAKOSUMI_DEPLOY_CONTROL_TOKEN: `test-${id}` },
      opentofuControlStore: store,
      opentofuRunner: routedRunner,
      runnerProfiles: [profile],
      defaultRunnerProfileId: profile.id,
      artifactReferenceAllocator,
      executionEvidenceAuthority: FIXTURE_EXECUTION_EVIDENCE_AUTHORITY,
      secretCrypto: STATE_CRYPTO,
    });

    const plan = await created.operations.createCapsulePlan(seeded.capsule.id);
    if (plan.planRun.status === "waiting_approval") {
      await created.operations.approveRun(plan.planRun.id, { approvedBy: "test-operator" });
    }
    const apply = await created.operations.createApplyRun({
      planRunId: plan.planRun.id,
      expected: applyExpectedGuardFromPlanRun(plan.planRun),
    });
    if (apply.applyRun.status !== "succeeded") {
      throw new Error(JSON.stringify(await created.operations.getRunLogs(apply.applyRun.id)));
    }
    expect(apply.applyRun.status).toBe("succeeded");
    expect(successfulApplyAcksDropped).toBe(1);
    expect(applyPosts).toBe(1);
    const applyRunId = apply.applyRun.id;
    expect(applyRunIdFromDispatch).toBe(applyRunId);
    expect(applyCompletionReadsAfterAckLoss).toBe(1, JSON.stringify(routedRequests));
    expect(completionReadbackAttemptId).toBe(preparationAttemptId);
    expect(completionReadbackEpoch).toBe(preparationEpoch);
    expect(completionReadback).toMatchObject({
      kind: "takosumi.local-mutation-success-readback@v2",
      result: { runId: applyRunId, action: "apply", status: "succeeded", exitCode: 0 },
    });
    expect(completionReadback?.resultDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(completionReadback?.stateDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(completionReadback?.outputDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(await readFile(applyMarker, "utf8")).toBe("dispatch\n");

    const capsule = await store.getCapsule(seeded.capsule.id);
    expect(capsule?.currentStateVersionId).toBe(apply.applyRun.stateVersionId);
    expect(capsule?.currentStateGeneration).toBe(1);
    const stateVersion = await store.getStateVersion(apply.applyRun.stateVersionId!);
    expect(stateVersion).toMatchObject({
      id: apply.applyRun.stateVersionId,
      capsuleId: seeded.capsule.id,
      generation: 1,
      createdByRunId: applyRunId,
    });
    expect(stateVersion?.digest).toBe(completionReadback?.stateDigest);
    expect(stateVersion?.stateRef).toBeTruthy();
    const committedState = await stateArtifactStore.read(stateVersion!.stateRef);
    expect(new TextDecoder().decode(committedState?.stateBytes)).toContain('"lineage":"local-v2-');
    expect(rawOutputRefs).toHaveLength(1);
    const committedRawOutputRef = rawOutputRefs[0]!;
    const encryptedRawOutput = await stateArtifactStore.readRawOutput(committedRawOutputRef);
    expect(encryptedRawOutput?.outputs.launch_url).toMatchObject({
      sensitive: false,
      value: "https://app.example.test",
    });
    const output = capsule?.currentOutputId ? await store.getOutput(capsule.currentOutputId) : undefined;
    expect(output).toBeDefined();
    expect(output?.publicOutputs).toEqual({ launch_url: "https://app.example.test" });
    expect(apply.applyRun.outputId).toBe(capsule?.currentOutputId);
    expect(output!.capsuleId).toBe(seeded.capsule.id);
    expect(output!.stateGeneration).toBe(1);
    expect(typeof output!.rawArtifactRef).toBe("string");
    expect(output!.rawArtifactRef).toBe(committedRawOutputRef);
    const persistedOutputRows = output
      ? await client.query<{ snapshot_json: unknown }>(
          "select snapshot_json from takosumi_outputs where id = $1",
          [output.id],
        )
      : { rows: [] };
    const dbSnapshot = persistedOutputRows.rows[0]?.snapshot_json;
    const dbOutput = typeof dbSnapshot === "string"
      ? JSON.parse(dbSnapshot) as { rawArtifactRef?: unknown }
      : dbSnapshot as { rawArtifactRef?: unknown } | undefined;
    if (JSON.stringify(output?.rawArtifactRef) !== JSON.stringify(committedRawOutputRef)) {
      throw new Error(JSON.stringify({
        allocatorRef: opaqueRefShape(committedRawOutputRef),
        adapterReturnedRef: opaqueRefShape(adapterReturnedRawOutputRef),
        coreCommitInputRef: opaqueRefShape(coreCommitRawOutputRef),
        databaseRowRef: opaqueRefShape(dbOutput?.rawArtifactRef),
        storeReadRef: opaqueRefShape(output?.rawArtifactRef),
      }));
    }
  } finally {
    if (previousPath === undefined) delete Bun.env.PATH;
    else Bun.env.PATH = previousPath;
    ackLossProxy?.stop(true);
    runnerServer?.stop(true);
    await client.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});
