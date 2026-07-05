#!/usr/bin/env bun

import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const PROOF_KIND = "takosumi.resource-shape-opentofu-provider-proof@v1";
const API_VERSION = "takosumi.dev/v1alpha1";
const PROVIDER_SOURCE = "takosjp/takosumi";
const PROVIDER_VERSION = "1.0.0";
const SPACE = "proof";

const SHAPES = [
  "EdgeWorker",
  "ObjectBucket",
  "KVStore",
  "Queue",
  "SQLDatabase",
  "ContainerService",
] as const;

type ShapeKind = (typeof SHAPES)[number];
type ProofProfile = "generic" | "takos-distribution" | "yurucommu-worker-app";

interface ProofResource {
  readonly apiVersion: typeof API_VERSION;
  readonly kind: ShapeKind;
  readonly metadata: {
    readonly name: string;
    readonly space: string;
    readonly managedBy?: string;
    readonly id?: string;
  };
  readonly spec?: Record<string, unknown>;
  readonly targetPoolName?: string;
  readonly status?: {
    readonly phase: string;
    readonly observedGeneration: number;
    readonly resolution: {
      readonly selectedImplementation: string;
      readonly target: string;
      readonly locked: boolean;
      readonly portability: string;
    };
    readonly outputs: Record<string, string>;
    readonly conditions: readonly {
      readonly type: string;
      readonly status: string;
    }[];
  };
  readonly id?: string;
}

interface ProofTargetPoolRecord {
  readonly id: string;
  readonly spaceId: string;
  readonly name: string;
  readonly spec: Record<string, unknown>;
}

export interface ResourceShapeOpenTofuProviderProof {
  readonly kind: typeof PROOF_KIND;
  readonly status: "passed";
  readonly profile: ProofProfile;
  readonly generatedAt: string;
  readonly tofuVersion: string;
  readonly providerBinaryDigest: string;
  readonly evidence: {
    readonly plannedResourceCount: number;
    readonly stateResourceCount: number;
    readonly previewRequestCount: number;
    readonly putResourceKinds: readonly ShapeKind[];
    readonly deleteResourceKinds: readonly ShapeKind[];
    readonly expectedResourceCountsByKind: Record<ShapeKind, number>;
    readonly putResourceCountsByKind: Record<ShapeKind, number>;
    readonly deleteResourceCountsByKind: Record<ShapeKind, number>;
    readonly targetPoolPutCount: number;
    readonly targetPoolDeleteCount: number;
    readonly outputKeys: readonly string[];
    readonly applyOutputDigest: string;
    readonly connectionRequestCount: number;
    readonly connectionResourceRefs: readonly string[];
    readonly composition?: {
      readonly app: "takos" | "yurucommu";
      readonly note: string;
      readonly worker: "EdgeWorker";
      readonly durableResources: readonly ShapeKind[];
      readonly containers?: readonly ["ContainerService"];
    };
  };
}

export interface ResourceShapeOpenTofuProviderLiveProof {
  readonly kind: typeof PROOF_KIND;
  readonly mode: "live";
  readonly status: "passed";
  readonly profile: ProofProfile;
  readonly generatedAt: string;
  readonly endpoint: string;
  readonly space: string;
  readonly target: {
    readonly type: string;
    readonly refDigest: string;
    readonly credentialRefDigest: string;
  };
  readonly prefix: string;
  readonly tofuVersion: string;
  readonly providerBinaryDigest: string;
  readonly capabilities: {
    readonly resources: Record<string, boolean>;
  };
  readonly skipped: readonly {
    readonly kind: ShapeKind;
    readonly reason: string;
  }[];
  readonly evidence: {
    readonly plannedResourceCount: number;
    readonly stateResourceCount: number;
    readonly appliedResourceKinds: readonly ShapeKind[];
    readonly expectedResourceCountsByKind: Record<ShapeKind, number>;
    readonly appliedResourceCountsByKind: Record<ShapeKind, number>;
    readonly fullProfileSatisfied: boolean;
    readonly providerBaseUrlConfigured: boolean;
    readonly outputKeys: readonly string[];
    readonly applyOutputDigest: string;
    readonly destroyCompleted: boolean;
    readonly remainingMatchingResourceCount: number;
    readonly remainingMatchingTargetPoolCount: number;
    readonly composition?: ResourceShapeOpenTofuProviderProof["evidence"]["composition"];
  };
}

interface LiveProofOptions {
  readonly endpoint: string;
  readonly space: string;
  readonly token: string;
  readonly targetType: string;
  readonly targetRef: string;
  readonly credentialRef: string;
  readonly targetProviderBaseUrl?: string;
  readonly targetPlugin?: string;
  readonly edgeWorkerArtifactUrl?: string;
  readonly edgeWorkerArtifactSha256?: string;
  readonly containerImageGit?: string;
  readonly containerImageAgent?: string;
  readonly outputPath?: string;
  readonly profile?: ProofProfile;
  readonly now?: () => string;
}

export async function runResourceShapeOpenTofuProviderProof(
  options: {
    readonly profile?: ProofProfile;
    readonly outputPath?: string;
    readonly now?: () => string;
  } = {},
): Promise<ResourceShapeOpenTofuProviderProof> {
  const temp = await mkdtemp(join(tmpdir(), "takosumi-resource-shape-tofu-"));
  const serverState = new ResourceShapeProofServer();
  const server = Bun.serve({
    port: 0,
    fetch: serverState.fetch,
  });

  try {
    const providerDir = join(temp, "provider-dev");
    const moduleDir = join(temp, "module");
    await mkdir(providerDir, { recursive: true });
    await mkdir(moduleDir, { recursive: true });

    const providerBinary = await buildProviderBinary(providerDir);
    const providerBinaryDigest = digestBytes(await readFile(providerBinary));
    const cliConfig = join(temp, "tofurc");
    await writeFile(
      cliConfig,
      `provider_installation {
  dev_overrides {
    "registry.opentofu.org/${PROVIDER_SOURCE}" = "${escapeHclString(providerDir)}"
  }
  direct {}
}
`,
    );
    const profile = options.profile ?? "generic";
    const expectedResourceCountsByKind = expectedCountsForProfile(profile);
    await writeFile(join(moduleDir, "main.tf"), moduleHcl(profile));

    const env = {
      ...process.env,
      TF_CLI_CONFIG_FILE: cliConfig,
      TF_IN_AUTOMATION: "1",
      TF_VAR_endpoint: `http://127.0.0.1:${server.port}`,
      TAKOSUMI_SPACE: SPACE,
    };

    // Provider development overrides intentionally skip `tofu init`; OpenTofu
    // tries to query the public registry during init even when the local plugin
    // binary is the desired proof subject.
    await runCommand(
      ["tofu", "plan", "-input=false", "-no-color", "-out=tfplan"],
      moduleDir,
      env,
    );
    const planJson = await runCommand(
      ["tofu", "show", "-json", "tfplan"],
      moduleDir,
      env,
    );
    const plannedResourceCount = countManagedResourceChanges(planJson);
    await runCommand(
      ["tofu", "apply", "-input=false", "-no-color", "tfplan"],
      moduleDir,
      env,
    );
    const outputsJson = await runCommand(
      ["tofu", "output", "-json"],
      moduleDir,
      env,
    );
    const stateList = await runCommand(
      ["tofu", "state", "list"],
      moduleDir,
      env,
    );
    await runCommand(
      ["tofu", "destroy", "-auto-approve", "-input=false", "-no-color"],
      moduleDir,
      env,
    );

    serverState.assertComplete(expectedResourceCountsByKind);
    const outputKeys = Object.keys(
      JSON.parse(outputsJson) as Record<string, unknown>,
    ).sort();
    const proof: ResourceShapeOpenTofuProviderProof = {
      kind: PROOF_KIND,
      status: "passed",
      profile,
      generatedAt: options.now?.() ?? new Date().toISOString(),
      tofuVersion: (
        await runCommand(["tofu", "version", "-json"], moduleDir, env)
      ).trim(),
      providerBinaryDigest,
      evidence: {
        plannedResourceCount,
        stateResourceCount: stateList
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean).length,
        previewRequestCount: serverState.previewCount,
        putResourceKinds: serverState.putKinds(),
        deleteResourceKinds: serverState.deleteKinds(),
        expectedResourceCountsByKind,
        putResourceCountsByKind: serverState.putCountsByKind(),
        deleteResourceCountsByKind: serverState.deleteCountsByKind(),
        targetPoolPutCount: serverState.targetPoolPutCount,
        targetPoolDeleteCount: serverState.targetPoolDeleteCount,
        outputKeys,
        applyOutputDigest: digestBytes(Buffer.from(outputsJson)),
        connectionRequestCount: serverState.connectionRequestCount(),
        connectionResourceRefs: serverState.connectionResourceRefs(),
        ...(compositionForProfile(profile)
          ? {
              composition: compositionForProfile(profile),
            }
          : {}),
      },
    };
    const expectedManagedResources =
      Object.values(expectedResourceCountsByKind).reduce(
        (sum, count) => sum + count,
        0,
      ) + 1;
    if (proof.evidence.plannedResourceCount < expectedManagedResources) {
      throw new Error(
        `expected at least ${expectedManagedResources} planned resources, got ${proof.evidence.plannedResourceCount}`,
      );
    }
    if (proof.evidence.stateResourceCount < expectedManagedResources) {
      throw new Error(
        `expected at least ${expectedManagedResources} state resources, got ${proof.evidence.stateResourceCount}`,
      );
    }
    if (options.outputPath) {
      await writeFile(
        resolve(options.outputPath),
        `${JSON.stringify(proof, null, 2)}\n`,
      );
    }
    return proof;
  } finally {
    server.stop(true);
    await rm(temp, { recursive: true, force: true });
  }
}

export async function runResourceShapeOpenTofuProviderLiveProof(
  options: LiveProofOptions,
): Promise<ResourceShapeOpenTofuProviderLiveProof> {
  const temp = await mkdtemp(join(tmpdir(), "takosumi-provider-live-"));
  try {
    const providerDir = join(temp, "provider");
    const moduleDir = join(temp, "module");
    await mkdir(providerDir, { recursive: true });
    await mkdir(moduleDir, { recursive: true });

    const providerBinary = await buildProviderBinary(providerDir);
    const providerBinaryDigest = digestBytes(await readFile(providerBinary));
    const cliConfig = join(temp, "tofurc");
    await writeFile(
      cliConfig,
      `provider_installation {
  dev_overrides {
    "registry.opentofu.org/${PROVIDER_SOURCE}" = "${escapeHclString(providerDir)}"
  }
  direct {}
}
`,
    );

    const capabilities = await fetchLiveCapabilities(options);
    const profile = options.profile ?? "generic";
    const livePlan = liveMaterializableShapes(capabilities.resources, {
      ...options,
      profile,
    });
    const prefix =
      options.now?.().replace(/\D/g, "").slice(0, 14) ||
      new Date().toISOString().replace(/\D/g, "").slice(0, 14);
    const resourcePrefix = `live-${prefix}`;
    await writeFile(
      join(moduleDir, "main.tf"),
      liveModuleHcl({
        ...options,
        profile,
        resourcePrefix,
        resourceCounts: livePlan.resourceCountsByKind,
      }),
    );

    const env = {
      ...process.env,
      TF_CLI_CONFIG_FILE: cliConfig,
      TF_IN_AUTOMATION: "1",
      TF_VAR_endpoint: options.endpoint,
      TF_VAR_space: options.space,
      TF_VAR_token: options.token,
      TF_VAR_target_type: options.targetType,
      TF_VAR_target_ref: options.targetRef,
      TF_VAR_credential_ref: options.credentialRef,
      TF_VAR_target_provider_base_url: options.targetProviderBaseUrl,
      TF_VAR_target_plugin: options.targetPlugin,
      TF_VAR_edge_worker_artifact_url: options.edgeWorkerArtifactUrl,
      TF_VAR_edge_worker_artifact_sha256: options.edgeWorkerArtifactSha256,
      TF_VAR_container_image_git: options.containerImageGit,
      TF_VAR_container_image_agent: options.containerImageAgent,
      TAKOSUMI_ENDPOINT: options.endpoint,
      TAKOSUMI_SPACE: options.space,
      TAKOSUMI_TOKEN: options.token,
    };

    let destroyCompleted = false;
    let applyStarted = false;
    let outputsJson = "{}";
    let stateList = "";
    let plannedResourceCount = 0;
    let applyError: unknown;

    try {
      await runCommand(
        [
          "tofu",
          "plan",
          "-input=false",
          "-no-color",
          "-parallelism=1",
          "-out=tfplan",
        ],
        moduleDir,
        env,
      );
      const planJson = await runCommand(
        ["tofu", "show", "-json", "tfplan"],
        moduleDir,
        env,
      );
      plannedResourceCount = countManagedResourceChanges(planJson);
      applyStarted = true;
      await runCommand(
        [
          "tofu",
          "apply",
          "-input=false",
          "-no-color",
          "-parallelism=1",
          "tfplan",
        ],
        moduleDir,
        env,
      );
      outputsJson = await runCommand(
        ["tofu", "output", "-json"],
        moduleDir,
        env,
      );
      stateList = await runCommand(["tofu", "state", "list"], moduleDir, env);
    } catch (error) {
      applyError = error;
      throw error;
    } finally {
      if (applyStarted) {
        try {
          await runCommand(
            [
              "tofu",
              "destroy",
              "-auto-approve",
              "-input=false",
              "-no-color",
              "-parallelism=1",
            ],
            moduleDir,
            env,
          );
          destroyCompleted = true;
        } catch (destroyError) {
          if (!applyError) throw destroyError;
        }
      }
    }

    const remaining = await fetchLiveMatches(options, resourcePrefix);
    const outputKeys = Object.keys(
      JSON.parse(outputsJson) as Record<string, unknown>,
    ).sort();
    const proof: ResourceShapeOpenTofuProviderLiveProof = {
      kind: PROOF_KIND,
      mode: "live",
      status: "passed",
      profile,
      generatedAt: options.now?.() ?? new Date().toISOString(),
      endpoint: options.endpoint,
      space: options.space,
      target: {
        type: options.targetType,
        refDigest: digestBytes(Buffer.from(options.targetRef)),
        credentialRefDigest: digestBytes(Buffer.from(options.credentialRef)),
      },
      prefix: resourcePrefix,
      tofuVersion: (
        await runCommand(["tofu", "version", "-json"], moduleDir, env)
      ).trim(),
      providerBinaryDigest,
      capabilities,
      skipped: livePlan.skipped,
      evidence: {
        plannedResourceCount,
        stateResourceCount: stateList
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean).length,
        appliedResourceKinds: livePlan.shapes,
        expectedResourceCountsByKind: livePlan.expectedResourceCountsByKind,
        appliedResourceCountsByKind: livePlan.resourceCountsByKind,
        fullProfileSatisfied: livePlan.fullProfileSatisfied,
        providerBaseUrlConfigured:
          typeof options.targetProviderBaseUrl === "string" &&
          options.targetProviderBaseUrl.trim().length > 0,
        outputKeys,
        applyOutputDigest: digestBytes(Buffer.from(outputsJson)),
        destroyCompleted,
        remainingMatchingResourceCount: remaining.resources,
        remainingMatchingTargetPoolCount: remaining.targetPools,
        ...(compositionForProfile(profile)
          ? { composition: compositionForProfile(profile) }
          : {}),
      },
    };

    const expectedLiveManagedResources =
      Object.values(livePlan.resourceCountsByKind).reduce(
        (sum, count) => sum + count,
        0,
      ) + 1;
    if (proof.evidence.plannedResourceCount < expectedLiveManagedResources) {
      throw new Error(
        `expected at least ${expectedLiveManagedResources} planned resources, got ${proof.evidence.plannedResourceCount}`,
      );
    }
    if (proof.evidence.stateResourceCount < expectedLiveManagedResources) {
      throw new Error(
        `expected at least ${expectedLiveManagedResources} state resources, got ${proof.evidence.stateResourceCount}`,
      );
    }
    if (!proof.evidence.destroyCompleted) {
      throw new Error("live proof destroy did not complete");
    }
    if (
      proof.evidence.remainingMatchingResourceCount > 0 ||
      proof.evidence.remainingMatchingTargetPoolCount > 0
    ) {
      throw new Error(
        `live proof cleanup left ${proof.evidence.remainingMatchingResourceCount} resources and ${proof.evidence.remainingMatchingTargetPoolCount} target pools`,
      );
    }
    if (options.outputPath) {
      await writeFile(
        resolve(options.outputPath),
        `${JSON.stringify(proof, null, 2)}\n`,
      );
    }
    return proof;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

class ResourceShapeProofServer {
  readonly resources = new Map<string, ProofResource>();
  readonly appliedResources: ProofResource[] = [];
  readonly deletedResources: ProofResource[] = [];
  readonly connectedResources: ProofResource[] = [];
  readonly targetPools = new Map<string, ProofTargetPoolRecord>();
  previewCount = 0;
  targetPoolPutCount = 0;
  targetPoolDeleteCount = 0;

  readonly fetch = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/.well-known/takosumi") {
      return json({
        api_versions: [API_VERSION],
        features: {
          resource_shapes: true,
          oidc: true,
        },
        endpoints: {},
      });
    }
    if (request.method === "GET" && url.pathname === "/v1/capabilities") {
      return json({
        apiVersion: API_VERSION,
        resources: Object.fromEntries(SHAPES.map((kind) => [kind, true])),
        adapters: { opentofu: true },
        compat: {},
        identity: { oidc_issuer: true },
        commercial: { billing: false },
      });
    }
    if (request.method === "POST" && url.pathname === "/v1/resources/preview") {
      this.previewCount++;
      const body = await request.json();
      return json({
        resource: this.readyResource(body as Partial<ProofResource>),
        selectedImplementation: "proof_preview",
        selectedTarget: "proof-target",
        portability: "portable",
        nativeResourcePlan: [],
        riskNotes: [],
        summary: "local Resource Shape provider proof preview",
      });
    }

    const resourceMatch = url.pathname.match(
      /^\/v1\/resources\/([^/]+)\/([^/]+)$/,
    );
    if (resourceMatch) {
      const kind = decodeURIComponent(resourceMatch[1]!) as ShapeKind;
      const name = decodeURIComponent(resourceMatch[2]!);
      if (!SHAPES.includes(kind)) return notFound(`unsupported kind ${kind}`);
      if (request.method === "PUT") {
        const body = (await request.json()) as Partial<ProofResource>;
        if (body.kind !== kind)
          return badRequest(`body kind ${body.kind} does not match ${kind}`);
        if (body.metadata?.managedBy !== "opentofu") {
          return badRequest("metadata.managedBy must be opentofu");
        }
        if (body.metadata?.space !== SPACE) {
          return badRequest(`metadata.space must be ${SPACE}`);
        }
        if (body.spec?.name !== name) {
          return badRequest(`spec.name must be ${name}`);
        }
        const record = this.readyResource(body);
        if (
          record.spec?.connections &&
          typeof record.spec.connections === "object" &&
          !Array.isArray(record.spec.connections)
        ) {
          this.connectedResources.push(record);
        }
        this.appliedResources.push(record);
        this.resources.set(
          resourceKey(kind, name, record.metadata.space),
          record,
        );
        return json(record);
      }
      if (request.method === "GET") {
        const space = url.searchParams.get("space") || SPACE;
        const record = this.resources.get(resourceKey(kind, name, space));
        return record ? json(record) : notFound(`${kind}/${name} not found`);
      }
      if (request.method === "DELETE") {
        const space = url.searchParams.get("space") || SPACE;
        const key = resourceKey(kind, name, space);
        const record = this.resources.get(key);
        if (record) this.deletedResources.push(record);
        this.resources.delete(key);
        return new Response(null, { status: 204 });
      }
    }

    const targetPoolMatch = url.pathname.match(/^\/v1\/target-pools\/([^/]+)$/);
    if (targetPoolMatch) {
      const name = decodeURIComponent(targetPoolMatch[1]!);
      if (request.method === "PUT") {
        this.targetPoolPutCount++;
        const body = (await request.json()) as {
          readonly space?: string;
          readonly spec?: Record<string, unknown>;
        };
        if (body.space !== SPACE)
          return badRequest(`target pool space must be ${SPACE}`);
        const record: ProofTargetPoolRecord = {
          id: `tkrn:${SPACE}:TargetPool:${name}`,
          spaceId: SPACE,
          name,
          spec: body.spec ?? {},
        };
        this.targetPools.set(`${SPACE}/${name}`, record);
        return json(record);
      }
      if (request.method === "GET") {
        const space = url.searchParams.get("space") || SPACE;
        const record = this.targetPools.get(`${space}/${name}`);
        return record ? json(record) : notFound(`TargetPool/${name} not found`);
      }
      if (request.method === "DELETE") {
        this.targetPoolDeleteCount++;
        const space = url.searchParams.get("space") || SPACE;
        this.targetPools.delete(`${space}/${name}`);
        return new Response(null, { status: 204 });
      }
    }

    return notFound(`${request.method} ${url.pathname}`);
  };

  readyResource(body: Partial<ProofResource>): ProofResource {
    const kind = body.kind as ShapeKind;
    const name = String(body.metadata?.name ?? body.spec?.name ?? "unnamed");
    const space = body.metadata?.space || SPACE;
    const id = `tkrn:${space}:${kind}:${name}`;
    return {
      apiVersion: API_VERSION,
      kind,
      id,
      metadata: {
        name,
        space,
        managedBy: body.metadata?.managedBy,
        id,
      },
      spec: body.spec ?? { name },
      ...(body.targetPoolName ? { targetPoolName: body.targetPoolName } : {}),
      status: {
        phase: "Ready",
        observedGeneration: 1,
        resolution: {
          selectedImplementation: `proof_${snakeCase(kind)}`,
          target: "proof-target",
          locked: true,
          portability: "portable",
        },
        outputs: {
          name,
          url: `proof://${snakeCase(kind)}/${name}`,
          resource_id: id,
        },
        conditions: [{ type: "Ready", status: "True" }],
      },
    };
  }

  putKinds(): readonly ShapeKind[] {
    return [
      ...new Set(this.appliedResources.map((record) => record.kind)),
    ].sort();
  }

  deleteKinds(): readonly ShapeKind[] {
    return [
      ...new Set(this.deletedResources.map((record) => record.kind)),
    ].sort();
  }

  putCountsByKind(): Record<ShapeKind, number> {
    return countResourcesByKind(this.appliedResources);
  }

  deleteCountsByKind(): Record<ShapeKind, number> {
    return countResourcesByKind(this.deletedResources);
  }

  connectionRequestCount(): number {
    let count = 0;
    for (const record of this.connectedResources) {
      const connections = record.spec?.connections;
      if (
        connections &&
        typeof connections === "object" &&
        !Array.isArray(connections)
      ) {
        count += Object.keys(connections).length;
      }
    }
    return count;
  }

  connectionResourceRefs(): readonly string[] {
    const refs = new Set<string>();
    for (const record of this.connectedResources) {
      const connections = record.spec?.connections;
      if (
        !connections ||
        typeof connections !== "object" ||
        Array.isArray(connections)
      ) {
        continue;
      }
      for (const connection of Object.values(
        connections as Record<string, unknown>,
      )) {
        if (
          connection &&
          typeof connection === "object" &&
          !Array.isArray(connection)
        ) {
          const resource = (connection as { readonly resource?: unknown })
            .resource;
          if (typeof resource === "string" && resource.length > 0) {
            refs.add(resource);
          }
        }
      }
    }
    return [...refs].sort();
  }

  assertComplete(expectedCounts: Record<ShapeKind, number>): void {
    const putCounts = this.putCountsByKind();
    const deleteCounts = this.deleteCountsByKind();
    for (const kind of SHAPES) {
      const expected = expectedCounts[kind];
      if (putCounts[kind] < expected)
        throw new Error(
          `Resource API received ${putCounts[kind]} PUTs for ${kind}; expected ${expected}`,
        );
      if (deleteCounts[kind] < expected) {
        throw new Error(
          `Resource API received ${deleteCounts[kind]} DELETEs for ${kind}; expected ${expected}`,
        );
      }
    }
    if (this.targetPoolPutCount < 1)
      throw new Error("TargetPool was not applied");
    if (this.targetPoolDeleteCount < 1)
      throw new Error("TargetPool was not deleted");
  }
}

async function buildProviderBinary(providerDir: string): Promise<string> {
  const binaryPath = join(providerDir, "terraform-provider-takosumi");
  await runCommand(
    ["go", "build", "-trimpath", "-o", binaryPath, "."],
    resolve("provider"),
    { ...process.env, CGO_ENABLED: process.env.CGO_ENABLED ?? "0" },
  );
  await copyFile(
    binaryPath,
    join(providerDir, `${basename(binaryPath)}_v${PROVIDER_VERSION}`),
  );
  return binaryPath;
}

function expectedCountsForProfile(
  profile: ProofProfile,
): Record<ShapeKind, number> {
  if (profile === "takos-distribution") {
    return {
      EdgeWorker: 1,
      ObjectBucket: 1,
      KVStore: 1,
      Queue: 2,
      SQLDatabase: 1,
      ContainerService: 2,
    };
  }
  if (profile === "yurucommu-worker-app") {
    return {
      EdgeWorker: 1,
      ObjectBucket: 1,
      KVStore: 1,
      Queue: 2,
      SQLDatabase: 1,
      ContainerService: 0,
    };
  }
  return {
    EdgeWorker: 1,
    ObjectBucket: 1,
    KVStore: 1,
    Queue: 1,
    SQLDatabase: 1,
    ContainerService: 1,
  };
}

function countResourcesByKind(
  resources: readonly ProofResource[],
): Record<ShapeKind, number> {
  const counts = Object.fromEntries(SHAPES.map((kind) => [kind, 0])) as Record<
    ShapeKind,
    number
  >;
  for (const resource of resources) {
    counts[resource.kind]++;
  }
  return counts;
}

function moduleHcl(profile: ProofProfile): string {
  if (profile === "takos-distribution") return takosDistributionModuleHcl();
  if (profile === "yurucommu-worker-app") return yurucommuWorkerAppModuleHcl();
  return genericModuleHcl();
}

function compositionForProfile(
  profile: ProofProfile,
): ResourceShapeOpenTofuProviderProof["evidence"]["composition"] | undefined {
  if (profile === "takos-distribution") {
    return {
      app: "takos",
      note: "Takos is expressed as generic Resource Shapes with explicit non-secret connections: one EdgeWorker, durable data/binding shapes, queues, and separate container services. This proof deliberately avoids a takosumi_takos catch-all resource.",
      worker: "EdgeWorker",
      durableResources: ["SQLDatabase", "KVStore", "ObjectBucket", "Queue"],
      containers: ["ContainerService"],
    };
  }
  if (profile === "yurucommu-worker-app") {
    return {
      app: "yurucommu",
      note: "Yurucommu is expressed as a generic Worker-compatible app shape: one EdgeWorker, SQL database, media object bucket, KV store, and delivery/DLQ queues. This proof deliberately avoids a yurucommu-specific provider resource.",
      worker: "EdgeWorker",
      durableResources: ["SQLDatabase", "ObjectBucket", "KVStore", "Queue"],
    };
  }
  return undefined;
}

function genericModuleHcl(): string {
  return `terraform {
  required_providers {
    takosumi = {
      source  = "${PROVIDER_SOURCE}"
      version = "${PROVIDER_VERSION}"
    }
  }
}

variable "endpoint" {
  type = string
}

provider "takosumi" {
  endpoint = var.endpoint
  space    = "${SPACE}"
}

resource "takosumi_target_pool" "default" {
  name = "default"

  target = [{
    name     = "proof-target"
    type     = "takosumi_native"
    ref      = "local-proof"
    priority = 100

    implementation = [
      {
        shape                = "EdgeWorker"
        implementation       = "proof_edge_worker"
        native_resource_type = "proof.edge_worker"
        interfaces = {
          worker_fetch     = "native"
          workers_bindings = "native"
        }
      },
      {
        shape                = "ObjectBucket"
        implementation       = "proof_object_bucket"
        native_resource_type = "proof.object_bucket"
        interfaces = {
          s3_api     = "native"
          signed_url = "native"
        }
      },
      {
        shape                = "KVStore"
        implementation       = "proof_kv_store"
        native_resource_type = "proof.kv_store"
        interfaces = {
          kv_api = "native"
        }
      },
      {
        shape                = "Queue"
        implementation       = "proof_queue"
        native_resource_type = "proof.queue"
        interfaces = {
          publish = "native"
          consume = "native"
        }
      },
      {
        shape                = "SQLDatabase"
        implementation       = "proof_sql_database"
        native_resource_type = "proof.sql_database"
        interfaces = {
          sqlite = "native"
        }
      },
      {
        shape                = "ContainerService"
        implementation       = "proof_container_service"
        native_resource_type = "proof.container_service"
        interfaces = {
          oci_container = "native"
          public_http   = "shim"
        }
      }
    ]
  }]
}

resource "takosumi_edge_worker" "api" {
  name               = "api"
  artifact_path      = "/work/dist/worker.js"
  compatibility_date = "2026-06-29"
  profiles           = ["workers_bindings"]
  target_pool        = takosumi_target_pool.default.name
}

resource "takosumi_object_bucket" "assets" {
  name        = "assets"
  interfaces  = ["s3_api", "signed_url"]
  target_pool = takosumi_target_pool.default.name
}

resource "takosumi_kv_store" "cache" {
  name        = "cache"
  consistency = "eventual"
  target_pool = takosumi_target_pool.default.name
}

resource "takosumi_queue" "delivery" {
  name           = "delivery"
  max_retries    = 5
  max_batch_size = 25
  target_pool    = takosumi_target_pool.default.name
}

resource "takosumi_sql_database" "main" {
  name            = "main"
  engine          = "sqlite"
  migrations_path = "migrations"
  target_pool     = takosumi_target_pool.default.name
}

resource "takosumi_container_service" "agent" {
  name        = "agent"
  image       = "ghcr.io/example/agent:1.0.0"
  ports       = [8080]
  public_http = true
  target_pool = takosumi_target_pool.default.name

  environment = {
    NODE_ENV = "production"
  }
}

output "shape_ids" {
  value = {
    edge_worker       = takosumi_edge_worker.api.id
    object_bucket     = takosumi_object_bucket.assets.id
    kv_store          = takosumi_kv_store.cache.id
    queue             = takosumi_queue.delivery.id
    sql_database      = takosumi_sql_database.main.id
    container_service = takosumi_container_service.agent.id
    target_pool       = takosumi_target_pool.default.id
  }
}

output "shape_urls" {
  value = {
    edge_worker       = takosumi_edge_worker.api.outputs["url"]
    object_bucket     = takosumi_object_bucket.assets.outputs["url"]
    kv_store          = takosumi_kv_store.cache.outputs["url"]
    queue             = takosumi_queue.delivery.outputs["url"]
    sql_database      = takosumi_sql_database.main.outputs["url"]
    container_service = takosumi_container_service.agent.outputs["url"]
  }
}
`;
}

function takosDistributionModuleHcl(): string {
  return `${modulePreambleHcl()}

${proofTargetPoolHcl("takos-proof-target")}

resource "takosumi_edge_worker" "takos_worker" {
  name               = "takos-worker"
  artifact_path      = "/work/dist/takos-worker.js"
  compatibility_date = "2026-06-29"
  profiles           = ["workers_bindings", "node_compat"]
  target_pool        = takosumi_target_pool.default.name

  connections = [
    {
      name        = "DATABASE"
      resource    = takosumi_sql_database.workspace.id
      permissions = ["connect"]
      projection  = "database_url"
    },
    {
      name        = "SESSION"
      resource    = takosumi_kv_store.session.id
      permissions = ["read", "write"]
      projection  = "runtime_binding"
    },
    {
      name        = "FILES"
      resource    = takosumi_object_bucket.files.id
      permissions = ["read", "write"]
      projection  = "runtime_binding"
    },
    {
      name        = "AGENT_JOBS"
      resource    = takosumi_queue.agent_jobs.id
      permissions = ["publish"]
      projection  = "runtime_binding"
    },
    {
      name        = "EVENTS"
      resource    = takosumi_queue.events.id
      permissions = ["publish"]
      projection  = "runtime_binding"
    }
  ]
}

resource "takosumi_sql_database" "workspace" {
  name            = "takos-workspace"
  engine          = "sqlite"
  migrations_path = "deploy/opentofu/migrations"
  target_pool     = takosumi_target_pool.default.name
}

resource "takosumi_kv_store" "session" {
  name        = "takos-session"
  consistency = "eventual"
  target_pool = takosumi_target_pool.default.name
}

resource "takosumi_object_bucket" "files" {
  name        = "takos-files"
  interfaces  = ["s3_api", "signed_url"]
  target_pool = takosumi_target_pool.default.name
}

resource "takosumi_queue" "agent_jobs" {
  name           = "takos-agent-jobs"
  max_retries    = 5
  max_batch_size = 10
  target_pool    = takosumi_target_pool.default.name
}

resource "takosumi_queue" "events" {
  name           = "takos-events"
  max_retries    = 3
  max_batch_size = 50
  target_pool    = takosumi_target_pool.default.name
}

resource "takosumi_container_service" "git" {
  name        = "takos-git"
  image       = "ghcr.io/takosjp/takos-git:1.0.0"
  ports       = [8080]
  public_http = false
  target_pool = takosumi_target_pool.default.name

  environment = {
    TAKOS_SERVICE = "git"
  }
}

resource "takosumi_container_service" "agent" {
  name        = "takos-agent"
  image       = "ghcr.io/takosjp/takos-agent:1.0.0"
  ports       = [8080]
  public_http = false
  target_pool = takosumi_target_pool.default.name

  environment = {
    TAKOS_SERVICE = "agent"
  }

  connections = [
    {
      name        = "AGENT_JOBS"
      resource    = takosumi_queue.agent_jobs.id
      permissions = ["consume", "publish"]
      projection  = "env"
    },
    {
      name        = "FILES"
      resource    = takosumi_object_bucket.files.id
      permissions = ["read", "write"]
      projection  = "env"
    },
    {
      name        = "EVENTS"
      resource    = takosumi_queue.events.id
      permissions = ["publish"]
      projection  = "env"
    }
  ]
}

output "takos_shape_ids" {
  value = {
    worker      = takosumi_edge_worker.takos_worker.id
    workspace   = takosumi_sql_database.workspace.id
    session     = takosumi_kv_store.session.id
    files       = takosumi_object_bucket.files.id
    agent_jobs  = takosumi_queue.agent_jobs.id
    events      = takosumi_queue.events.id
    git         = takosumi_container_service.git.id
    agent       = takosumi_container_service.agent.id
    target_pool = takosumi_target_pool.default.id
  }
}

output "takos_shape_outputs" {
  value = {
    worker     = takosumi_edge_worker.takos_worker.outputs
    workspace  = takosumi_sql_database.workspace.outputs
    session    = takosumi_kv_store.session.outputs
    files      = takosumi_object_bucket.files.outputs
    agent_jobs = takosumi_queue.agent_jobs.outputs
    events     = takosumi_queue.events.outputs
    git        = takosumi_container_service.git.outputs
    agent      = takosumi_container_service.agent.outputs
  }
}
`;
}

function yurucommuWorkerAppModuleHcl(): string {
  return `${modulePreambleHcl()}

${proofTargetPoolHcl("yurucommu-proof-target")}

resource "takosumi_edge_worker" "yurucommu_worker" {
  name               = "yurucommu-worker"
  artifact_path      = "/work/dist/yurucommu-worker.js"
  compatibility_date = "2026-06-29"
  profiles           = ["workers_bindings"]
  target_pool        = takosumi_target_pool.default.name

  connections = [
    {
      name        = "DB"
      resource    = takosumi_sql_database.database.id
      permissions = ["connect"]
      projection  = "runtime_binding"
    },
    {
      name        = "MEDIA"
      resource    = takosumi_object_bucket.media.id
      permissions = ["read", "write"]
      projection  = "runtime_binding"
    },
    {
      name        = "KV"
      resource    = takosumi_kv_store.kv.id
      permissions = ["read", "write"]
      projection  = "runtime_binding"
    },
    {
      name        = "DELIVERY_QUEUE"
      resource    = takosumi_queue.delivery.id
      permissions = ["publish"]
      projection  = "runtime_binding"
    },
    {
      name        = "DELIVERY_DLQ"
      resource    = takosumi_queue.delivery_dlq.id
      permissions = ["publish"]
      projection  = "runtime_binding"
    }
  ]
}

resource "takosumi_sql_database" "database" {
  name            = "yurucommu-db"
  engine          = "sqlite"
  migrations_path = "migrations"
  target_pool     = takosumi_target_pool.default.name
}

resource "takosumi_object_bucket" "media" {
  name        = "yurucommu-media"
  interfaces  = ["s3_api", "signed_url"]
  target_pool = takosumi_target_pool.default.name
}

resource "takosumi_kv_store" "kv" {
  name        = "yurucommu-kv"
  consistency = "eventual"
  target_pool = takosumi_target_pool.default.name
}

resource "takosumi_queue" "delivery" {
  name           = "yurucommu-delivery"
  max_retries    = 3
  max_batch_size = 10
  target_pool    = takosumi_target_pool.default.name
}

resource "takosumi_queue" "delivery_dlq" {
  name           = "yurucommu-delivery-dlq"
  max_retries    = 1
  max_batch_size = 10
  target_pool    = takosumi_target_pool.default.name
}

output "yurucommu_shape_ids" {
  value = {
    worker      = takosumi_edge_worker.yurucommu_worker.id
    database    = takosumi_sql_database.database.id
    media       = takosumi_object_bucket.media.id
    kv          = takosumi_kv_store.kv.id
    delivery    = takosumi_queue.delivery.id
    delivery_dlq = takosumi_queue.delivery_dlq.id
    target_pool = takosumi_target_pool.default.id
  }
}

output "yurucommu_shape_outputs" {
  value = {
    worker       = takosumi_edge_worker.yurucommu_worker.outputs
    database     = takosumi_sql_database.database.outputs
    media        = takosumi_object_bucket.media.outputs
    kv           = takosumi_kv_store.kv.outputs
    delivery     = takosumi_queue.delivery.outputs
    delivery_dlq = takosumi_queue.delivery_dlq.outputs
  }
}
`;
}

function modulePreambleHcl(): string {
  return `terraform {
  required_providers {
    takosumi = {
      source  = "${PROVIDER_SOURCE}"
      version = "${PROVIDER_VERSION}"
    }
  }
}

variable "endpoint" {
  type = string
}

provider "takosumi" {
  endpoint = var.endpoint
  space    = "${SPACE}"
}`;
}

function proofTargetPoolHcl(targetName: string): string {
  return `resource "takosumi_target_pool" "default" {
  name = "default"

  target = [{
    name     = "${targetName}"
    type     = "takosumi_native"
    ref      = "local-proof"
    priority = 100

    implementation = [
      {
        shape                = "EdgeWorker"
        implementation       = "proof_edge_worker"
        native_resource_type = "proof.edge_worker"
        interfaces = {
          worker_fetch     = "native"
          workers_bindings = "native"
        }
      },
      {
        shape                = "ObjectBucket"
        implementation       = "proof_object_bucket"
        native_resource_type = "proof.object_bucket"
        interfaces = {
          s3_api     = "native"
          signed_url = "native"
        }
      },
      {
        shape                = "KVStore"
        implementation       = "proof_kv_store"
        native_resource_type = "proof.kv_store"
        interfaces = {
          kv_api = "native"
        }
      },
      {
        shape                = "Queue"
        implementation       = "proof_queue"
        native_resource_type = "proof.queue"
        interfaces = {
          publish = "native"
          consume = "native"
        }
      },
      {
        shape                = "SQLDatabase"
        implementation       = "proof_sql_database"
        native_resource_type = "proof.sql_database"
        interfaces = {
          sqlite = "native"
        }
      },
      {
        shape                = "ContainerService"
        implementation       = "proof_container_service"
        native_resource_type = "proof.container_service"
        interfaces = {
          oci_container = "native"
          public_http   = "shim"
        }
      }
    ]
  }]
}`;
}

function liveMaterializableShapes(
  resources: Record<string, boolean>,
  options: Pick<
    LiveProofOptions,
    | "edgeWorkerArtifactUrl"
    | "edgeWorkerArtifactSha256"
    | "containerImageGit"
    | "containerImageAgent"
    | "profile"
  >,
): {
  readonly shapes: readonly ShapeKind[];
  readonly expectedResourceCountsByKind: Record<ShapeKind, number>;
  readonly resourceCountsByKind: Record<ShapeKind, number>;
  readonly fullProfileSatisfied: boolean;
  readonly skipped: readonly {
    readonly kind: ShapeKind;
    readonly reason: string;
  }[];
} {
  const expectedResourceCountsByKind = expectedCountsForProfile(
    options.profile ?? "generic",
  );
  const resourceCountsByKind = Object.fromEntries(
    SHAPES.map((kind) => [kind, 0]),
  ) as Record<ShapeKind, number>;
  const shapes: ShapeKind[] = [];
  const skipped: { kind: ShapeKind; reason: string }[] = [];
  for (const kind of SHAPES) {
    const expectedCount = expectedResourceCountsByKind[kind];
    if (expectedCount < 1) continue;
    if (!resources[kind]) {
      skipped.push({ kind, reason: "endpoint capability is disabled" });
      continue;
    }
    if (kind === "EdgeWorker") {
      if (options.edgeWorkerArtifactUrl && options.edgeWorkerArtifactSha256) {
        shapes.push(kind);
        resourceCountsByKind[kind] = expectedCount;
      } else {
        skipped.push({
          kind,
          reason:
            "live provider proof requires --edge-worker-artifact-url and --edge-worker-artifact-sha256 so the server-side OpenTofu runner can fetch a declared release artifact",
        });
      }
      continue;
    }
    if (kind === "ContainerService") {
      const missingImages = containerServiceNames(expectedCount).filter(
        (serviceName) => !containerImageForServiceName(serviceName, options),
      );
      if (missingImages.length > 0) {
        skipped.push({
          kind,
          reason: `live provider proof requires release container image refs for ${missingImages.join(", ")}; pass --container-image-git/--container-image-agent or TAKOSUMI_PROOF_CONTAINER_IMAGE_GIT/TAKOSUMI_PROOF_CONTAINER_IMAGE_AGENT`,
        });
        continue;
      }
      shapes.push(kind);
      resourceCountsByKind[kind] = expectedCount;
      continue;
    }
    shapes.push(kind);
    resourceCountsByKind[kind] = expectedCount;
  }
  if (shapes.length === 0) {
    throw new Error("no live-materializable Resource Shape capabilities found");
  }
  const fullProfileSatisfied = SHAPES.every(
    (kind) => resourceCountsByKind[kind] === expectedResourceCountsByKind[kind],
  );
  return {
    shapes,
    expectedResourceCountsByKind,
    resourceCountsByKind,
    fullProfileSatisfied,
    skipped,
  };
}

function containerServiceName(index: number): "git" | "agent" {
  return index === 0 ? "git" : "agent";
}

function containerServiceNames(count: number): readonly ("git" | "agent")[] {
  return Array.from({ length: count }, (_, index) =>
    containerServiceName(index),
  );
}

function containerImageForServiceName(
  serviceName: "git" | "agent",
  options: Pick<
    LiveProofOptions,
    "containerImageGit" | "containerImageAgent"
  >,
): string | undefined {
  return serviceName === "git"
    ? options.containerImageGit
    : options.containerImageAgent;
}

function liveModuleHcl({
  resourcePrefix,
  profile,
  resourceCounts,
  targetProviderBaseUrl,
  targetPlugin,
}: LiveProofOptions & {
  readonly resourcePrefix: string;
  readonly profile: ProofProfile;
  readonly resourceCounts: Record<ShapeKind, number>;
}): string {
  const resources: string[] = [];
  const idOutputs: string[] = [];
  const shapeOutputs: string[] = [];
  const has = (kind: ShapeKind) => resourceCounts[kind] > 0;
  if (has("EdgeWorker")) {
    const connections = liveEdgeWorkerConnectionsHcl(profile, resourceCounts);
    resources.push(`resource "takosumi_edge_worker" "api" {
  name            = "${resourcePrefix}-edge"
  artifact_url    = var.edge_worker_artifact_url
  artifact_sha256 = var.edge_worker_artifact_sha256
  target_pool     = takosumi_target_pool.live.name
${connections}
}
`);
    idOutputs.push(`edge_worker = takosumi_edge_worker.api.id`);
    shapeOutputs.push(`edge_worker = takosumi_edge_worker.api.outputs`);
  }
  if (has("ObjectBucket")) {
    resources.push(`resource "takosumi_object_bucket" "assets" {
  name        = "${resourcePrefix}-assets"
  interfaces  = ["s3_api", "signed_url"]
  target_pool = takosumi_target_pool.live.name
}
`);
    idOutputs.push(`object_bucket = takosumi_object_bucket.assets.id`);
    shapeOutputs.push(`object_bucket = takosumi_object_bucket.assets.outputs`);
  }
  if (has("KVStore")) {
    resources.push(`resource "takosumi_kv_store" "cache" {
  name        = "${resourcePrefix}-cache"
  consistency = "eventual"
  target_pool = takosumi_target_pool.live.name
}
`);
    idOutputs.push(`kv_store = takosumi_kv_store.cache.id`);
    shapeOutputs.push(`kv_store = takosumi_kv_store.cache.outputs`);
  }
  if (resourceCounts.Queue > 0) {
    for (let index = 0; index < resourceCounts.Queue; index++) {
      const localName = liveQueueLocalName(profile, index);
      const outputName = liveQueueOutputName(profile, index);
      const suffix = liveQueueNameSuffix(profile, index);
      resources.push(`resource "takosumi_queue" "${localName}" {
  name           = "${resourcePrefix}-${suffix}"
  max_retries    = 3
  max_batch_size = 10
  target_pool    = takosumi_target_pool.live.name
}
`);
      idOutputs.push(`${outputName} = takosumi_queue.${localName}.id`);
      shapeOutputs.push(`${outputName} = takosumi_queue.${localName}.outputs`);
    }
  }
  if (has("SQLDatabase")) {
    resources.push(`resource "takosumi_sql_database" "main" {
  name        = "${resourcePrefix}-db"
  engine      = "sqlite"
  target_pool = takosumi_target_pool.live.name
}
`);
    idOutputs.push(`sql_database = takosumi_sql_database.main.id`);
    shapeOutputs.push(`sql_database = takosumi_sql_database.main.outputs`);
  }
  if (resourceCounts.ContainerService > 0) {
    for (let index = 0; index < resourceCounts.ContainerService; index++) {
      const serviceName = containerServiceName(index);
      const localName = serviceName;
      const connections =
        localName === "agent"
          ? liveContainerServiceConnectionsHcl(resourceCounts)
          : "";
      resources.push(`resource "takosumi_container_service" "${localName}" {
  name        = "${resourcePrefix}-${serviceName}"
  image       = var.container_image_${localName}
  ports       = [8080]
  public_http = false
  target_pool = takosumi_target_pool.live.name
${connections}

  environment = {
    TAKOS_SERVICE = "${serviceName}"
  }
}
`);
      idOutputs.push(
        `container_${localName} = takosumi_container_service.${localName}.id`,
      );
      shapeOutputs.push(
        `container_${localName} = takosumi_container_service.${localName}.outputs`,
      );
    }
  }
  return `terraform {
  required_providers {
    takosumi = {
      source  = "${PROVIDER_SOURCE}"
      version = "${PROVIDER_VERSION}"
    }
  }
}

variable "endpoint" {
  type = string
}

variable "space" {
  type = string
}

variable "token" {
  type      = string
  sensitive = true
}

variable "target_type" {
  type = string
}

variable "target_ref" {
  type = string
}

variable "credential_ref" {
  type = string
}

variable "target_provider_base_url" {
  type    = string
  default = ""
}

variable "target_plugin" {
  type    = string
  default = ""
}

variable "edge_worker_artifact_url" {
  type    = string
  default = ""
}

variable "edge_worker_artifact_sha256" {
  type    = string
  default = ""
}

variable "container_image_git" {
  type    = string
  default = ""
}

variable "container_image_agent" {
  type    = string
  default = ""
}

provider "takosumi" {
  endpoint = var.endpoint
  space    = var.space
  token    = var.token
}

resource "takosumi_target_pool" "live" {
  name = "${resourcePrefix}"

  target = [{
    name           = "live-main"
    type           = var.target_type
    ref            = var.target_ref
    credential_ref = var.credential_ref
    priority       = 100
${managedCompatImplementationHcl({ targetProviderBaseUrl, targetPlugin })}
  }]
}

${resources.join("\n")}
output "shape_ids" {
  value = {
    ${idOutputs.join("\n    ")}
    target_pool = takosumi_target_pool.live.id
  }
}

output "shape_outputs" {
  value = {
    ${shapeOutputs.join("\n    ")}
  }
}
`;
}

function liveEdgeWorkerConnectionsHcl(
  profile: ProofProfile,
  resourceCounts: Record<ShapeKind, number>,
): string {
  const connections: string[] = [];
  if (resourceCounts.SQLDatabase > 0) {
    connections.push(`{
      name        = "${profile === "takos-distribution" ? "DATABASE" : "DB"}"
      resource    = takosumi_sql_database.main.id
      permissions = ["connect"]
      projection  = "runtime_binding"
    }`);
  }
  if (resourceCounts.ObjectBucket > 0) {
    connections.push(`{
      name        = "${profile === "takos-distribution" ? "FILES" : "MEDIA"}"
      resource    = takosumi_object_bucket.assets.id
      permissions = ["read", "write"]
      projection  = "runtime_binding"
    }`);
  }
  if (resourceCounts.KVStore > 0) {
    connections.push(`{
      name        = "${profile === "takos-distribution" ? "SESSION" : "KV"}"
      resource    = takosumi_kv_store.cache.id
      permissions = ["read", "write"]
      projection  = "runtime_binding"
    }`);
  }
  if (resourceCounts.Queue > 0) {
    connections.push(`{
      name        = "${profile === "takos-distribution" ? "AGENT_JOBS" : "DELIVERY_QUEUE"}"
      resource    = takosumi_queue.${liveQueueLocalName(profile, 0)}.id
      permissions = ["publish"]
      projection  = "runtime_binding"
    }`);
  }
  if (resourceCounts.Queue > 1) {
    connections.push(`{
      name        = "${profile === "takos-distribution" ? "EVENTS" : "DELIVERY_DLQ"}"
      resource    = takosumi_queue.${liveQueueLocalName(profile, 1)}.id
      permissions = ["publish"]
      projection  = "runtime_binding"
    }`);
  }
  if (connections.length === 0) return "";
  return `

  connections = [
    ${connections.join(",\n    ")}
  ]`;
}

function liveContainerServiceConnectionsHcl(
  resourceCounts: Record<ShapeKind, number>,
): string {
  const connections: string[] = [];
  if (resourceCounts.Queue > 0) {
    connections.push(`{
      name        = "AGENT_JOBS"
      resource    = takosumi_queue.${liveQueueLocalName("takos-distribution", 0)}.id
      permissions = ["consume", "publish"]
      projection  = "env"
    }`);
  }
  if (resourceCounts.ObjectBucket > 0) {
    connections.push(`{
      name        = "FILES"
      resource    = takosumi_object_bucket.assets.id
      permissions = ["read", "write"]
      projection  = "env"
    }`);
  }
  if (resourceCounts.Queue > 1) {
    connections.push(`{
      name        = "EVENTS"
      resource    = takosumi_queue.${liveQueueLocalName("takos-distribution", 1)}.id
      permissions = ["publish"]
      projection  = "env"
    }`);
  }
  if (connections.length === 0) return "";
  return `

  connections = [
    ${connections.join(",\n    ")}
  ]`;
}

function liveQueueLocalName(profile: ProofProfile, index: number): string {
  if (profile === "takos-distribution")
    return index === 0 ? "agent_jobs" : "events";
  if (profile === "yurucommu-worker-app")
    return index === 0 ? "delivery" : "delivery_dlq";
  return index === 0 ? "delivery" : `delivery_${index + 1}`;
}

function liveQueueOutputName(profile: ProofProfile, index: number): string {
  if (profile === "takos-distribution")
    return index === 0 ? "agent_jobs" : "events";
  if (profile === "yurucommu-worker-app")
    return index === 0 ? "delivery" : "delivery_dlq";
  return index === 0 ? "queue" : `queue_${index + 1}`;
}

function liveQueueNameSuffix(profile: ProofProfile, index: number): string {
  if (profile === "takos-distribution")
    return index === 0 ? "agent-jobs" : "events";
  if (profile === "yurucommu-worker-app")
    return index === 0 ? "delivery" : "delivery-dlq";
  return index === 0 ? "queue" : `queue-${index + 1}`;
}

function managedCompatImplementationHcl({
  targetProviderBaseUrl,
  targetPlugin,
}: {
  readonly targetProviderBaseUrl: string | undefined;
  readonly targetPlugin: string | undefined;
}): string {
  if (!targetProviderBaseUrl && !targetPlugin) return "";
  const plugin = targetPlugin
    ? `
        plugin         = var.target_plugin`
    : "";
  const options = targetProviderBaseUrl
    ? `options_json = jsonencode({
          providerBaseUrl = var.target_provider_base_url
        })`
    : "";
  return `
    implementation = [
      {
        shape          = "EdgeWorker"
        implementation = "cloudflare_workers"
        ${plugin}
        interfaces = {
          worker_fetch        = "native"
          workers_bindings    = "native"
          node_compat         = "shim"
          service_bindings    = "native"
          static_assets       = "native"
          resource_connection = "native"
          runtime_binding     = "native"
          grant_connect       = "native"
          grant_read          = "native"
          grant_write         = "native"
          grant_publish       = "native"
        }
        ${options}
      },
      {
        shape          = "ContainerService"
        implementation = "cloudflare_container"
        ${plugin}
        interfaces = {
          oci_container       = "native"
          private_http        = "native"
          service_connection  = "native"
          resource_connection = "native"
          env_projection      = "native"
          env                 = "native"
          grant_read          = "native"
          grant_write         = "native"
          grant_publish       = "native"
          grant_consume       = "native"
        }
        ${options}
      },
      {
        shape          = "ObjectBucket"
        implementation = "cloudflare_r2_bucket"
        ${plugin}
        interfaces = {
          object_store  = "native"
          s3_api        = "native"
          signed_url    = "native"
          object_events = "shim"
        }
        ${options}
      },
      {
        shape          = "KVStore"
        implementation = "cloudflare_kv_namespace"
        ${plugin}
        interfaces = {
          kv_store        = "native"
          runtime_binding = "native"
        }
        ${options}
      },
      {
        shape          = "Queue"
        implementation = "cloudflare_queue"
        ${plugin}
        interfaces = {
          queue       = "native"
          publish     = "native"
          consume     = "native"
          cloudevents = "shim"
        }
        ${options}
      },
      {
        shape          = "SQLDatabase"
        implementation = "cloudflare_d1_database"
        ${plugin}
        interfaces = {
          sql        = "native"
          sqlite     = "native"
          migrations = "shim"
        }
        ${options}
      }
    ]`;
}

async function fetchLiveCapabilities(options: {
  readonly endpoint: string;
  readonly token: string;
}): Promise<{ readonly resources: Record<string, boolean> }> {
  const response = await fetch(`${options.endpoint}/v1/capabilities`, {
    headers: { Authorization: `Bearer ${options.token}` },
  });
  if (!response.ok) {
    throw new Error(
      `/v1/capabilities failed with ${response.status}: ${await response.text()}`,
    );
  }
  const body = (await response.json()) as {
    readonly resources?: Record<string, boolean>;
  };
  return { resources: body.resources ?? {} };
}

async function fetchLiveMatches(
  options: Pick<LiveProofOptions, "endpoint" | "space" | "token">,
  prefix: string,
): Promise<{ readonly resources: number; readonly targetPools: number }> {
  const headers = { Authorization: `Bearer ${options.token}` };
  const resourceResponse = await fetch(
    `${options.endpoint}/v1/resources?space=${encodeURIComponent(options.space)}`,
    { headers },
  );
  if (!resourceResponse.ok) {
    throw new Error(
      `/v1/resources failed with ${resourceResponse.status}: ${await resourceResponse.text()}`,
    );
  }
  const targetPoolResponse = await fetch(
    `${options.endpoint}/v1/target-pools?space=${encodeURIComponent(options.space)}`,
    { headers },
  );
  if (!targetPoolResponse.ok) {
    throw new Error(
      `/v1/target-pools failed with ${targetPoolResponse.status}: ${await targetPoolResponse.text()}`,
    );
  }
  const resourceBody = (await resourceResponse.json()) as {
    readonly resources?: readonly ProofResource[];
  };
  const targetPoolBody = (await targetPoolResponse.json()) as {
    readonly targetPools?: readonly ProofTargetPoolRecord[];
  };
  return {
    resources: (resourceBody.resources ?? []).filter((record) =>
      String(record.metadata?.name ?? record.id ?? "").startsWith(prefix),
    ).length,
    targetPools: (targetPoolBody.targetPools ?? []).filter((record) =>
      String(record.name ?? record.id).startsWith(prefix),
    ).length,
  };
}

async function runCommand(
  command: readonly string[],
  cwd: string,
  env: Record<string, string | undefined>,
): Promise<string> {
  const proc = Bun.spawn(command, {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new Response(proc.stdout).text();
  const stderr = new Response(proc.stderr).text();
  const [out, err, exitCode] = await Promise.all([stdout, stderr, proc.exited]);
  if (exitCode !== 0) {
    throw new Error(
      `${command.join(" ")} failed with ${exitCode}\n${err}\n${out}`,
    );
  }
  return out;
}

function countManagedResourceChanges(planJson: string): number {
  const parsed = JSON.parse(planJson) as {
    readonly resource_changes?: readonly {
      readonly mode?: string;
      readonly change?: { readonly actions?: readonly string[] };
    }[];
  };
  return (parsed.resource_changes ?? []).filter((entry) => {
    const actions = entry.change?.actions ?? [];
    return (
      entry.mode === "managed" && actions.some((action) => action !== "no-op")
    );
  }).length;
}

function resourceKey(kind: ShapeKind, name: string, space: string): string {
  return `${space}/${kind}/${name}`;
}

function json(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(value), { ...init, headers });
}

function notFound(message: string): Response {
  return json(
    { error: { code: "not_found", message, requestId: "proof" } },
    {
      status: 404,
    },
  );
}

function badRequest(message: string): Response {
  return json(
    { error: { code: "bad_request", message, requestId: "proof" } },
    {
      status: 400,
    },
  );
}

function snakeCase(value: string): string {
  return value.replace(
    /[A-Z]/g,
    (part, index) => `${index === 0 ? "" : "_"}${part.toLowerCase()}`,
  );
}

function escapeHclString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function digestBytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

if (import.meta.main) {
  const outputPath = argValue("--output");
  const live = process.argv.includes("--live");
  const proof = live
    ? await runResourceShapeOpenTofuProviderLiveProof({
        endpoint:
          argValue("--endpoint") ??
          process.env.TAKOSUMI_ENDPOINT ??
          "https://app.takosumi.com",
        space: requiredArgOrEnv("--space", "TAKOSUMI_SPACE"),
        token: await tokenFromArgs(),
        targetType:
          argValue("--target-type") ??
          process.env.TAKOSUMI_LIVE_TARGET_TYPE ??
          "cloudflare",
        targetRef: requiredArgOrEnv("--target-ref", "TAKOSUMI_LIVE_TARGET_REF"),
        credentialRef: requiredArgOrEnv(
          "--credential-ref",
          "TAKOSUMI_LIVE_CREDENTIAL_REF",
        ),
        targetProviderBaseUrl:
          argValue("--target-provider-base-url") ??
          process.env.TAKOSUMI_LIVE_TARGET_PROVIDER_BASE_URL,
        targetPlugin:
          argValue("--target-plugin") ??
          process.env.TAKOSUMI_LIVE_TARGET_PLUGIN,
        edgeWorkerArtifactUrl:
          argValue("--edge-worker-artifact-url") ??
          process.env.TAKOSUMI_LIVE_EDGE_WORKER_ARTIFACT_URL,
        edgeWorkerArtifactSha256:
          argValue("--edge-worker-artifact-sha256") ??
          process.env.TAKOSUMI_LIVE_EDGE_WORKER_ARTIFACT_SHA256,
        containerImageGit:
          argValue("--container-image-git") ??
          process.env.TAKOSUMI_PROOF_CONTAINER_IMAGE_GIT,
        containerImageAgent:
          argValue("--container-image-agent") ??
          process.env.TAKOSUMI_PROOF_CONTAINER_IMAGE_AGENT,
        profile: profileFromArgs(),
        ...(outputPath ? { outputPath } : {}),
      })
    : await runResourceShapeOpenTofuProviderProof({
        profile: profileFromArgs(),
        ...(outputPath ? { outputPath } : {}),
      });
  console.log(JSON.stringify(proof, null, 2));
}

function profileFromArgs(): ProofProfile {
  const profile = argValue("--profile") ?? "generic";
  if (
    profile === "generic" ||
    profile === "takos-distribution" ||
    profile === "yurucommu-worker-app"
  ) {
    return profile;
  }
  throw new Error(
    `unsupported --profile ${profile}; expected generic, takos-distribution, or yurucommu-worker-app`,
  );
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function requiredArgOrEnv(argName: string, envName: string): string {
  const value = argValue(argName) ?? process.env[envName];
  if (!value) {
    throw new Error(`${argName} or ${envName} is required`);
  }
  return value;
}

async function tokenFromArgs(): Promise<string> {
  const tokenFile = argValue("--token-file");
  if (tokenFile) return (await readFile(resolve(tokenFile), "utf8")).trim();
  const token = argValue("--token") ?? process.env.TAKOSUMI_TOKEN;
  if (!token) {
    throw new Error("--token-file, --token, or TAKOSUMI_TOKEN is required");
  }
  return token;
}
