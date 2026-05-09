// Direct deploy service tests — Deployment-centric.
//
// Direct deploy generates a public app manifest payload from raw image / source
// / bundle inputs, then runs it through `DeploymentService.resolveDeployment` +
// `applyDeployment`. These tests validate the manifest and source synthesis
// helpers as well as the full DirectDeployService flow against a stub
// DeploymentClient.

import assert from "node:assert/strict";
import {
  type ApplyDeploymentOutcome,
  buildDirectWorkloadManifest,
  buildDirectWorkloadSource,
  type DirectDeployDeploymentClient,
  type DirectDeployResolveInput,
  DirectDeployService,
  isDirectDeployGeneratedManifest,
  isDirectDeployGeneratedManifestSnapshot,
  ManifestManagedGroupMutationBlockedError,
} from "./mod.ts";
import type { Deployment, GroupHead } from "takosumi-contract";

const IMAGE_API =
  "registry.example.com/demo/api@sha256:1111111111111111111111111111111111111111111111111111111111111111";

Deno.test("buildDirectWorkloadManifest emits the takosumi.directDeploy override", () => {
  const manifest = buildDirectWorkloadManifest({
    kind: "image",
    spaceId: "space-a",
    groupId: "demo-app",
    workloadName: "api",
    image: IMAGE_API,
  });
  assert.equal(manifest.name, "demo-app");
  assert.equal(manifest.compute?.api.image, IMAGE_API);
  assert.deepEqual(manifest.overrides?.["takosumi.directDeploy"], {
    generated: true,
    inputKind: "image",
  });
  assert.equal(isDirectDeployGeneratedManifest(manifest), true);
});

Deno.test("buildDirectWorkloadSource maps each input kind to a DeploySourceRef", () => {
  assert.deepEqual(
    buildDirectWorkloadSource({
      kind: "image",
      spaceId: "space-a",
      groupId: "demo-app",
      image: IMAGE_API,
    }),
    { kind: "manifest", uri: `direct:image:${IMAGE_API}` },
  );
  assert.deepEqual(
    buildDirectWorkloadSource({
      kind: "source",
      spaceId: "space-a",
      groupId: "from-source",
      repositoryUrl: "https://git.example.com/acme/app.git",
      ref: "main",
      commitSha: "abc123",
    }),
    {
      kind: "git_ref",
      repositoryUrl: "https://git.example.com/acme/app.git",
      ref: "main",
      commitSha: "abc123",
    },
  );
  assert.deepEqual(
    buildDirectWorkloadSource({
      kind: "bundle",
      spaceId: "space-a",
      groupId: "from-bundle",
      packageName: "@acme/app",
      packageVersion: "2.0.0",
      uri: "s3://bundles/app.tgz",
    }),
    {
      kind: "package",
      packageName: "@acme/app",
      packageVersion: "2.0.0",
      uri: "s3://bundles/app.tgz",
    },
  );
});

Deno.test("isDirectDeployGeneratedManifestSnapshot detects the marker in JSON snapshots", () => {
  const snapshot = JSON.stringify({
    name: "demo-app",
    overrides: {
      "takosumi.directDeploy": { generated: true, inputKind: "image" },
    },
  });
  assert.equal(isDirectDeployGeneratedManifestSnapshot(snapshot), true);
  assert.equal(isDirectDeployGeneratedManifestSnapshot("{}"), false);
});

Deno.test("DirectDeployService.resolve emits a resolved Deployment via the client", async () => {
  const client = new StubDirectDeploymentClient();
  const service = new DirectDeployService({ deploymentService: client });

  const result = await service.resolve({
    kind: "image",
    spaceId: "space-a",
    groupId: "demo-app",
    workloadName: "api",
    image: IMAGE_API,
  });

  assert.equal(result.manifest.name, "demo-app");
  assert.equal(result.deployment.status, "resolved");
  assert.equal(client.resolveCalls.length, 1);
  assert.equal(client.applyCalls.length, 0);
  assert.equal(client.resolveCalls[0].mode, "resolve");
});

Deno.test("DirectDeployService.apply resolves and immediately applies", async () => {
  const client = new StubDirectDeploymentClient();
  const service = new DirectDeployService({ deploymentService: client });

  const result = await service.apply({
    kind: "image",
    spaceId: "space-a",
    groupId: "demo-app",
    image: IMAGE_API,
  });

  assert.equal(result.deployment.status, "applied");
  assert.equal(result.groupHead.current_deployment_id, result.deployment.id);
  assert.equal(client.resolveCalls[0].mode, "apply");
  assert.equal(client.applyCalls.length, 1);
});

Deno.test("DirectDeployService rejects mutating a manifest-managed group without opt-in", async () => {
  const client = new StubDirectDeploymentClient({
    existingHead: {
      space_id: "space-a",
      group_id: "demo-app",
      current_deployment_id: "deploy_existing",
      previous_deployment_id: null,
      generation: 3,
      advanced_at: "2026-04-30T00:00:00.000Z",
    },
    existingDeployment: {
      // Existing deployment was authored from a manifest, not direct deploy.
      manifestSnapshot: JSON.stringify({
        name: "demo-app",
        version: "1.0.0",
      }),
    },
  });
  const service = new DirectDeployService({ deploymentService: client });

  await assert.rejects(
    () =>
      service.apply({
        kind: "image",
        spaceId: "space-a",
        groupId: "demo-app",
        image: IMAGE_API,
      }),
    ManifestManagedGroupMutationBlockedError,
  );
});

Deno.test("DirectDeployService allows mutation when opt-in flag is set", async () => {
  const client = new StubDirectDeploymentClient({
    existingHead: {
      space_id: "space-a",
      group_id: "demo-app",
      current_deployment_id: "deploy_existing",
      previous_deployment_id: null,
      generation: 3,
      advanced_at: "2026-04-30T00:00:00.000Z",
    },
    existingDeployment: {
      manifestSnapshot: JSON.stringify({
        name: "demo-app",
        version: "1.0.0",
      }),
    },
  });
  const service = new DirectDeployService({ deploymentService: client });

  const result = await service.apply({
    kind: "image",
    spaceId: "space-a",
    groupId: "demo-app",
    image: IMAGE_API,
    allowManifestManagedGroupMutation: true,
  });
  assert.equal(result.deployment.status, "applied");
});

class StubDirectDeploymentClient implements DirectDeployDeploymentClient {
  readonly resolveCalls: DirectDeployResolveInput[] = [];
  readonly applyCalls: string[] = [];
  readonly #existingHead?: GroupHead;
  readonly #existingDeployment?: { manifestSnapshot: string };
  #counter = 0;

  constructor(
    options: {
      existingHead?: GroupHead;
      existingDeployment?: { manifestSnapshot: string };
    } = {},
  ) {
    this.#existingHead = options.existingHead;
    this.#existingDeployment = options.existingDeployment;
  }

  resolveDeployment(input: DirectDeployResolveInput): Promise<Deployment> {
    this.resolveCalls.push(input);
    const id = `deploy_resolved_${this.#counter++}`;
    return Promise.resolve(makeDeployment(id, input.spaceId, input.groupId));
  }

  applyDeployment(deploymentId: string): Promise<ApplyDeploymentOutcome> {
    this.applyCalls.push(deploymentId);
    return Promise.resolve({
      deployment: makeDeployment(
        deploymentId,
        "space-a",
        "demo-app",
        "applied",
      ),
      groupHead: {
        space_id: "space-a",
        group_id: "demo-app",
        current_deployment_id: deploymentId,
        previous_deployment_id: this.#existingHead?.current_deployment_id ??
          null,
        generation: (this.#existingHead?.generation ?? 0) + 1,
        advanced_at: "2026-04-30T00:00:00.000Z",
      },
    });
  }

  getDeployment(deploymentId: string): Promise<Deployment | undefined> {
    if (
      this.#existingDeployment &&
      this.#existingHead?.current_deployment_id === deploymentId
    ) {
      const dep = makeDeployment(deploymentId, "space-a", "demo-app");
      return Promise.resolve({
        ...dep,
        input: {
          ...dep.input,
          manifest_snapshot: this.#existingDeployment.manifestSnapshot,
        },
      });
    }
    return Promise.resolve(undefined);
  }

  getGroupHead(
    _spaceId: string,
    _groupId: string,
  ): Promise<GroupHead | undefined> {
    return Promise.resolve(this.#existingHead);
  }
}

function makeDeployment(
  id: string,
  spaceId: string,
  groupId: string,
  status: "resolved" | "applied" = "resolved",
): Deployment {
  return {
    id,
    group_id: groupId,
    space_id: spaceId,
    input: {
      manifest_snapshot: JSON.stringify({
        name: groupId,
        overrides: {
          "takosumi.directDeploy": { generated: true, inputKind: "image" },
        },
      }),
      source_kind: "inline",
    },
    resolution: {
      descriptor_closure: {
        resolutions: [],
        dependencies: [],
        closureDigest: "sha256:empty",
        createdAt: "2026-04-30T00:00:00.000Z",
      },
      resolved_graph: {
        digest: "sha256:empty",
        components: [],
        projections: [],
      },
    },
    desired: {
      routes: [],
      bindings: [],
      resources: [],
      runtime_network_policy: {
        policyDigest: "sha256:empty",
        defaultEgress: "deny-by-default",
      },
      activation_envelope: {
        primary_assignment: {
          componentAddress: "component:api",
          weight: 1000,
        },
        envelopeDigest: "sha256:empty",
      },
    },
    status,
    conditions: [],
    policy_decisions: [],
    approval: null,
    rollback_target: null,
    created_at: "2026-04-30T00:00:00.000Z",
    applied_at: status === "applied" ? "2026-04-30T00:00:00.000Z" : null,
    finalized_at: status === "applied" ? "2026-04-30T00:00:00.000Z" : null,
  };
}
