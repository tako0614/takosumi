import { expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { ObjectKeyArtifactReferenceAllocator } from "../../../../core/adapters/storage/artifact-references.ts";
import { PhaseMintBundle } from "../../../../core/adapters/vault/mod.ts";
import { D1AppOwnershipStore } from "../../../../core/domains/app-ownership/store.ts";
import {
  OpenTofuController,
  type OpenTofuRunner,
} from "../../../../core/domains/deploy-control/mod.ts";
import { CloudflareD1OpenTofuControlStore } from "../../../../worker/src/d1_opentofu_store.ts";
import {
  FIXTURE_CLOUDFLARE_MIRROR_EVIDENCE,
  FIXTURE_CLOUDFLARE_PROVIDER,
  FIXTURE_EXECUTION_EVIDENCE_AUTHORITY,
  seedCapsuleModel,
  seedProviderConnections,
} from "../../../helpers/deploy-control/model_fixture.ts";
import { workerdD1Database, workerdD1Module } from "../../../helpers/deploy-control/workerd_d1.ts";

const DIGEST = `sha256:${"a".repeat(64)}`;

test("RunEngine resolves physical D1 app ownership before minting a same-Workspace connection", async () => {
  const runtime = new Miniflare({
    compatibilityDate: "2026-07-17",
    modules: [workerdD1Module("run-engine-app-ownership.mjs")],
    d1Databases: { CONTROL: "run-engine-app-ownership" },
  });
  try {
    const database = workerdD1Database(runtime);
    const store = new CloudflareD1OpenTofuControlStore(database);
    const seeded = await seedCapsuleModel(store, {
      environment: "preview",
      requiredProviders: [FIXTURE_CLOUDFLARE_PROVIDER],
    });
    await seedProviderConnections(store, seeded.capsule);
    const appOwnership = new D1AppOwnershipStore(database, store);
    const ownership = {
      capsuleId: seeded.capsule.id,
      ownerAccountId: "different-app-owner",
      ownershipEpoch: 0,
      managementState: "active" as const,
      managementEpoch: 0,
      storageRoot: `apps/${seeded.capsule.id}`,
    };
    expect(await appOwnership.initializeOwnershipIfMissing(ownership)).toBe(true);
    expect(await appOwnership.getOwnership(seeded.capsule.id)).toEqual(ownership);
    // Ownership is deliberately absent from the Capsule payload. The old
    // Workspace owner still owns this connection in the same Workspace.
    expect((await store.getCapsule(seeded.capsule.id))?.ownerAccountId).toBeUndefined();
    const [connection] = await store.listConnections(seeded.workspace.id);
    expect(connection?.ownerAccountId).toBe(seeded.workspace.ownerUserId);

    let mintCalls = 0;
    let runnerCalls = 0;
    const runner: OpenTofuRunner = {
      async plan() {
        runnerCalls += 1;
        return {
          planDigest: DIGEST,
          planArtifact: { kind: "runner-local", ref: "runner-local://plan/tfplan", digest: DIGEST },
          providerLockDigest: DIGEST,
          requiredProviders: [FIXTURE_CLOUDFLARE_PROVIDER],
          providerInstallation: [FIXTURE_CLOUDFLARE_MIRROR_EVIDENCE],
        };
      },
      async apply() { throw new Error("unused apply"); },
      async destroy() { throw new Error("unused destroy"); },
    };
    const controller = new OpenTofuController({
      store,
      appOwnership,
      runner,
      artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
      executionEvidenceAuthority: FIXTURE_EXECUTION_EVIDENCE_AUTHORITY,
      vault: {
        async mintForCapsuleProviderBindings(
          _workspaceId: string,
          entries: readonly { provider: string; connectionId: string }[],
        ) {
          mintCalls += 1;
          return new PhaseMintBundle(
            { env: { CLOUDFLARE_API_TOKEN: "fixture-only-token" } },
            [],
            entries.map((entry) => ({
              provider: entry.provider,
              connectionId: entry.connectionId,
              temporary: true,
              ttlEnforced: true,
            })),
          );
        },
      } as never,
    });
    const request = {
      workspaceId: seeded.workspace.id,
      capsuleId: seeded.capsule.id,
      source: { kind: "git" as const, url: seeded.source.url, commit: seeded.snapshot.resolvedCommit },
      requiredProviders: [FIXTURE_CLOUDFLARE_PROVIDER],
      requiredProviderRequirements: [{
        source: FIXTURE_CLOUDFLARE_PROVIDER,
        moduleLocalName: "cloudflare",
        allowed: true,
        credentialRequired: true,
      }],
    };
    const refusal = await controller.createPlanRun(request).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect({ refusal, mintCalls, runnerCalls }).toMatchObject({
      refusal: { code: "permission_denied", details: { reason: "connection_not_owned_by_app_owner" } },
      mintCalls: 0,
      runnerCalls: 0,
    });

    // A matching physical owner may use the same binding and reach mint and
    // dispatch. This rules out an unrelated admission failure as the refusal.
    expect(await appOwnership.putOwnership({
      ...ownership,
      ownerAccountId: seeded.workspace.ownerUserId,
      ownershipEpoch: 1,
      managementEpoch: 1,
    }, 0)).toBe(true);
    const { planRun } = await controller.createPlanRun(request);
    expect(planRun.status, JSON.stringify(planRun.diagnostics)).toBe("succeeded");
    expect(mintCalls).toBe(1);
    expect(runnerCalls).toBe(1);
  } finally {
    await runtime.dispose();
  }
}, 180_000);
